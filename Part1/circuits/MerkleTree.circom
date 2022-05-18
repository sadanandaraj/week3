pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/switcher.circom";

template CheckRoot(n) { // compute the root of a MerkleTree of n Levels 
    signal input leaves[2**n];
    signal output root;

    signal totalHashes[2**n-1];
    component poseidon[2**n-1];

    var indexHashes=0;
    var indexLeaves = 0;

    var leafHasheLenght = 2**n/2;

    for(var i=0; i<leafHasheLenght; i++){
        poseidon[i].inputs[0] <== leaves[indexLeaves];
        poseidon[i].inputs[1] <== leaves[indexLeaves+1];

        indexLeaves = indexLeaves+2;

        totalHashes[i] <== poseidon[i].out;
    }

    for(var i=leafHasheLenght; i<2**n-1; i++){
        poseidon[i].inputs[0] <== totalHashes[indexHashes];
        poseidon[i].inputs[0] <== totalHashes[indexHashes+1];

        indexHashes = indexHashes +2;

        totalHashes[i] <== poseidon[i].out;
    }

    root <== totalHashes[2**n-1];
 


}

template MerkleTreeInclusionProof(n) {
    signal input leaf;
    signal input path_elements[n];
    signal input path_index[n]; // path index are 0's and 1's indicating whether the current element is on the left or right
    signal output root; // note that this is an OUTPUT signal

    //[assignment] insert your code here to compute the root from a leaf and elements along the path

    component switcher[n];
   component hasher[n];

   for(var i=0;i<n;i++){
       switcher[i]=Switcher();
       switcher[i].L <== i == 0 ? leaf : hasher[i-1].out;
       switcher[i].R <== path_elements[i];
       switcher[i].sel <== path_index[i];
       //calculate hash
       hasher[i]=Poseidon(2);
        hasher[i].inputs[0] <== switcher[i].outL;
        hasher[i].inputs[1] <== switcher[i].outR;
   }

    root <== hasher[n-1].out;


}