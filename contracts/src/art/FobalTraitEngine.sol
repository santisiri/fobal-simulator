// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FobalArtConstants as K} from "./FobalArtConstants.sol";

/// @title FobalTraitEngine — seed to TraitVector, deterministically.
/// @notice Pure. Every branch resolves: there is no input for which this
/// reverts, because a reverting trait engine would take `tokenURI` down for
/// whatever token happened to hit it.
///
/// The seed deliberately excludes tokenId — the same (dna, appearance) must
/// render the same player forever, which is what lets a renderer be swapped
/// without re-identifying anybody.
library FobalTraitEngine {
    struct Traits {
        uint8 head;
        uint8 skin;
        uint8 eyes;
        uint8 brows;
        uint8 nose;
        uint8 mouth;
        uint8 hair;
        uint8 hairColor;
        uint8 beard;
        uint8 headwear;
        uint8 bg;
        uint8 accent;
        uint8 iris;
    }

    bytes32 internal constant DOMAIN = keccak256("fobal.art.v2");

    function seedOf(bytes32 dna, uint256 appearance) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(DOMAIN, dna, appearance));
    }

    function lane(bytes32 s0, string memory tag) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(s0, tag)));
    }

    /// @dev Walks the cumulative table; `r` is already reduced mod the
    /// denominator. Returns the last index if the table is malformed rather
    /// than reverting — totality over elegance.
    function pick(uint16[] memory cum, uint256 r) internal pure returns (uint8) {
        uint256 n = cum.length;
        for (uint256 k; k < n; ++k) {
            if (r < cum[k]) return uint8(k);
        }
        return uint8(n == 0 ? 0 : n - 1);
    }

    function _p(bytes32 s0, string memory tag, uint16[] memory cum) private pure returns (uint8) {
        return pick(cum, lane(s0, tag) % K.WEIGHT_DENOM);
    }

    function traitsOf(bytes32 s0) internal pure returns (Traits memory t) {
        t.head = _p(s0, "HEAD", _dyn(K.cumHead()));
        t.skin = _p(s0, "SKIN", _dyn8(K.cumSkin()));
        t.eyes = _p(s0, "EYES", _dyn10(K.cumEyes()));
        t.brows = _p(s0, "BROWS", _dyn8(K.cumBrows()));
        t.nose = _p(s0, "NOSE", _dyn3(K.cumNose()));
        t.mouth = _p(s0, "MOUTH", _dyn10(K.cumMouth()));
        t.hair = _p(s0, "HAIR", _dyn24(K.cumHair()));
        t.hairColor = _p(s0, "HAIRC", _dyn9(K.cumHairColor()));
        t.beard = _p(s0, "BEARD", _dyn8(K.cumBeard()));
        t.headwear = _p(s0, "HEADWEAR", _dyn10(K.cumHeadwear()));
        t.bg = _p(s0, "BG", _dyn8(K.cumBg()));
        t.accent = _p(s0, "ACCENT", _dyn8(K.cumAccent()));
        t.iris = _p(s0, "IRIS", _dyn4(K.cumIris()));

        // ---- CONSTRAINT PASS, identical to the JS reference
        uint256 hwBit = 1 << t.headwear;
        if (hwBit & K.HEADWEAR_COVERS_MASK != 0 && t.hair >= 10) t.hair = 3;
        if (t.hair == 0 && hwBit & K.HEADWEAR_BAND_MASK != 0) t.headwear = 0;
        if (t.beard >= 6 && t.mouth == 8) t.mouth = 5;
    }

    // fixed-size arrays are cheap to return but awkward to iterate; these
    // adapters exist only to keep `pick` single-shaped
    function _dyn(uint16[6] memory a) private pure returns (uint16[] memory o) {
        o = new uint16[](6);
        for (uint256 k; k < 6; ++k) o[k] = a[k];
    }
    function _dyn3(uint16[3] memory a) private pure returns (uint16[] memory o) {
        o = new uint16[](3);
        for (uint256 k; k < 3; ++k) o[k] = a[k];
    }
    function _dyn4(uint16[4] memory a) private pure returns (uint16[] memory o) {
        o = new uint16[](4);
        for (uint256 k; k < 4; ++k) o[k] = a[k];
    }
    function _dyn8(uint16[8] memory a) private pure returns (uint16[] memory o) {
        o = new uint16[](8);
        for (uint256 k; k < 8; ++k) o[k] = a[k];
    }
    function _dyn9(uint16[9] memory a) private pure returns (uint16[] memory o) {
        o = new uint16[](9);
        for (uint256 k; k < 9; ++k) o[k] = a[k];
    }
    function _dyn10(uint16[10] memory a) private pure returns (uint16[] memory o) {
        o = new uint16[](10);
        for (uint256 k; k < 10; ++k) o[k] = a[k];
    }
    function _dyn24(uint16[24] memory a) private pure returns (uint16[] memory o) {
        o = new uint16[](24);
        for (uint256 k; k < 24; ++k) o[k] = a[k];
    }
}
