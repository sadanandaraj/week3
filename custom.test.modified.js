const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const Utxo = require('../src/utxo')
const { transaction, registerAndTransact, prepareTransaction, buildMerkleTree } = require('../src/index')
const { toFixedHex, poseidonHash } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const { encodeDataForBridge } = require('./utils')

const MERKLE_TREE_HEIGHT = 5
const l1ChainId = 1
const MINIMUM_WITHDRAWAL_AMOUNT = utils.parseEther(process.env.MINIMUM_WITHDRAWAL_AMOUNT || '0.05')
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther(process.env.MAXIMUM_DEPOSIT_AMOUNT || '1')

describe('Custom Tests', function () {
  this.timeout(10000000)

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, l1Unwrapper, multisig] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const verifier16 = await deploy('Verifier16')
    const hasher = await deploy('Hasher')

    const token = await deploy('PermittableToken', 'Wrapped ETH', 'WETH', 18, l1ChainId)
    await token.mint(sender.address, utils.parseEther('10000'))

    const amb = await deploy('MockAMB', gov.address, l1ChainId)
    const omniBridge = await deploy('MockOmniBridge', amb.address)

    /** @type {TornadoPool} */
    const tornadoPoolImpl = await deploy(
      'TornadoPool',
      verifier2.address,
      verifier16.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
      token.address,
      omniBridge.address,
      l1Unwrapper.address,
      gov.address,
      l1ChainId,
      multisig.address,
    )

    const { data } = await tornadoPoolImpl.populateTransaction.initialize(
      MINIMUM_WITHDRAWAL_AMOUNT,
      MAXIMUM_DEPOSIT_AMOUNT,
    )
    const proxy = await deploy(
      'CrossChainUpgradeableProxy',
      tornadoPoolImpl.address,
      gov.address,
      data,
      amb.address,
      l1ChainId,
    )

    const tornadoPool = tornadoPoolImpl.attach(proxy.address)

    await token.approve(tornadoPool.address, utils.parseEther('10000'))

    return { tornadoPool, token, proxy, omniBridge, amb, gov, multisig }
  }

  it('[assignment] ii. deposit 0.1 ETH in L1 -> withdraw 0.08 ETH in L2 -> assert balances', async () => {
    const { tornadoPool, token, omniBridge } = await loadFixture(fixture)
    const aliceKeyPair = new Keypair() 

    // Alice deposits into tornado pool aliceDepositAmount aliceDepositUtxo onTokenBridgedData onTokenBridgedTx
    const aliceDepAmnt = utils.parseEther('0.1')
    const aliceDepstUtxo = new Utxo({ amount: aliceDepAmnt, keypair: aliceKeyPair })
    const { args, extData } = await prepareTransaction({
      tornadoPool,
      outputs: [aliceDepstUtxo],
    })

    const onTokenBridgData = encodeDataForBridge({
      proof: args,
      extData,
    })

    const onTokenBridgTx = await tornadoPool.populateTransaction.onTokenBridged(
      token.address,
      aliceDepstUtxo.amount,
      onTokenBridgData,
    )
    // emulating bridge. first it sends tokens to omnibridge mock then it sends to the pool
    await token.transfer(omniBridge.address, aliceDepAmnt)
    const transferTx = await token.populateTransaction.transfer(tornadoPool.address, aliceDepAmnt)

    await omniBridge.execute([
      { who: token.address, callData: transferTx.data }, 
      { who: tornadoPool.address, callData: onTokenBridgTx.data }, 
    ])

   
    const aliceWithdrawAmount = utils.parseEther('0.08')
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    
    const aliceChangedUtxo = new Utxo({
      amount: aliceDepAmnt.sub(aliceWithdrawAmount),
      keypair: aliceKeyPair,
    })
    await transaction({
      tornadoPool,
      inputs: [aliceDepstUtxo],
      outputs: [aliceChangedUtxo],
      recipient: recipient,
      isL1Withdrawal: false,
    })

    const recipientBalance = await token.balanceOf(recipient)
    expect(recipientBalance).to.be.equal(aliceWithdrawAmount)
    const omniBridgeBalance = await token.balanceOf(omniBridge.address)
    expect(omniBridgeBalance).to.be.equal(0)
    const tornadoPoolBalance = await token.balanceOf(tornadoPool.address)
    const expectedPoolBalance = utils.parseEther('0.02')
    expect(tornadoPoolBalance).to.be.equal(expectedPoolBalance)
  })

  it('[assignment] iii. Alice deposits 0.13 ETH in L1 -> transfer 0.06 ETH to Bob -> Bob withdraws on L2 -> Alice withdraws on L1', async () => {
    const { tornadoPool, token, omniBridge } = await loadFixture(fixture)
    const aliecKeyPair = new Keypair() // contains private and public keys 

    // Alice deposits into tornado pool
    const aliceDepAmnt = utils.parseEther('0.13')
    const aliceDepstUtxo = new Utxo({ amount: aliceDepAmnt, keypair: aliecKeyPair })
    const { args, extData } = await prepareTransaction({
      tornadoPool,
      outputs: [aliceDepstUtxo],
    })

    const onTokenBridgData = encodeDataForBridge({
      proof: args,
      extData,
    })

    const onTokenBridgTx = await tornadoPool.populateTransaction.onTokenBridged(
      token.address,
      aliceDepstUtxo.amount,
      onTokenBridgData,
    )
    await token.transfer(omniBridge.address, aliceDepAmnt)
    const transferTx = await token.populateTransaction.transfer(tornadoPool.address, aliceDepAmnt)

    await omniBridge.execute([
      { who: token.address, callData: transferTx.data }, // send tokens to pool
      { who: tornadoPool.address, callData: onTokenBridgTx.data }, // call onTokenBridgedTx
    ])

     const bobKeyPair = new Keypair() 
    const bobAddress = bobKeyPair.address() 

    // Alice sends some funds to Bob
    const bobSendAmount = utils.parseEther('0.06')
    const bobSendUtxo = new Utxo({ amount: bobSendAmount, keypair: Keypair.fromString(bobAddress) })
    const aliceChangedUtxo = new Utxo({
      amount: aliceDepAmnt.sub(bobSendAmount),
      keypair: aliceDepstUtxo.keypair,
    })
    await transaction({ tornadoPool, inputs: [aliceDepstUtxo], outputs: [bobSendUtxo, aliceChangedUtxo] })

    // Bob parses chain to detect incoming funds
    const filter = tornadoPool.filters.NewCommitment()
    const fromBlock = await ethers.provider.getBlock()
    const events = await tornadoPool.queryFilter(filter, fromBlock.number)
    let bobReceiveUtxo
    try {
      bobReceiveUtxo = Utxo.decrypt(bobKeyPair, events[0].args.encryptedOutput, events[0].args.index)
    } catch (e) {
     
      bobReceiveUtxo = Utxo.decrypt(bobKeyPair, events[1].args.encryptedOutput, events[1].args.index)
    }
    expect(bobReceiveUtxo.amount).to.be.equal(bobSendAmount)

    // Bob withdraws a part of his funds from the shielded pool
    const bobWithdrawAmount = utils.parseEther('0.06')
    const bobEthAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const bobChangeUtxo = new Utxo({ amount: bobSendAmount.sub(bobWithdrawAmount), keypair: bobKeypair })
    await transaction({
      tornadoPool,
      inputs: [bobReceiveUtxo],
      outputs: [bobChangeUtxo],
      recipient: bobEthAddress,
      isL1Withdrawal: false,
    })

    const bobBalance = await token.balanceOf(bobEthAddress)
    expect(bobBalance).to.be.equal(bobWithdrawAmount)

    // alice withdraws funds from the shielded pool
    const aliceWithdrawAmount = utils.parseEther('0.07')
    const recipient = '0x663a5Cd8DB310F17C9AAe1Ee0cE8D2A7a524F975'
    const aliceWithdrawUtxo = new Utxo({
      amount: aliceWithdrawAmount,
      keypair: aliecKeyPair,
    })
    await transaction({
      tornadoPool,
      inputs: [aliceChangedUtxo],
      outputs: [aliceWithdrawUtxo],
      recipient: recipient,
      isL1Withdrawal: true,
    })

    const recipientBalance = await token.balanceOf(recipient)
    expect(recipientBalance).to.be.equal(0)
    const omniBridgeBalance = await token.balanceOf(omniBridge.address)
    expect(omniBridgeBalance).to.be.equal(0)
    const tornadoPoolBalance = await token.balanceOf(tornadoPool.address)
    expect(tornadoPoolBalance).to.be.equal(aliceWithdrawAmount)
  })
})
