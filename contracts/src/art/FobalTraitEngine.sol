// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FobalArtConstants as K} from "./FobalArtConstants.sol";
import {FobalAnchors} from "./FobalAnchors.sol";

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
        uint8 ears;
        uint8 build;
        uint8 collar;
        uint8 neck;
        uint8 shading;
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

    function _p(bytes32 s0, string memory tag, uint256 cls) private pure returns (uint8) {
        return pick(K.cumOf(cls), lane(s0, tag) % K.WEIGHT_DENOM);
    }

    function traitsOf(bytes32 s0) internal pure returns (Traits memory t) {
        t.head = _p(s0, "HEAD", K.CLS_HEAD);
        t.skin = _p(s0, "SKIN", K.CLS_SKIN);
        t.ears = _p(s0, "EARS", K.CLS_EARS);
        t.eyes = _p(s0, "EYES", K.CLS_EYES);
        t.brows = _p(s0, "BROWS", K.CLS_BROWS);
        t.nose = _p(s0, "NOSE", K.CLS_NOSE);
        t.hair = _p(s0, "HAIR", K.CLS_HAIR);
        t.hairColor = _p(s0, "HAIRC", K.CLS_HAIRCOLOR);
        t.beard = _p(s0, "BEARD", K.CLS_BEARD);
        t.headwear = _p(s0, "HEADWEAR", K.CLS_HEADWEAR);
        t.bg = _p(s0, "BG", K.CLS_BG);
        t.accent = _p(s0, "ACCENT", K.CLS_ACCENT);
        t.iris = _p(s0, "IRIS", K.CLS_IRIS);
        t.build = _p(s0, "BUILD", K.CLS_BUILD);
        t.collar = _p(s0, "COLLAR", K.CLS_COLLAR);

        // ---- GEOMETRY CORRELATIONS (never human-trait correlations).
        // A wide skull can carry a wide mouth; a narrow one cannot. The head's
        // width class RESTRICTS the eligible set and the lane picks inside it,
        // so a narrow head lands on a defined narrow mouth rather than being
        // rerolled into an unrelated draw.
        t.mouth = _eligibleMouth(FobalAnchors.anchorsOf(t.head).widthClass, lane(s0, "MOUTH"));
        // Shoulders decide the neck; one fewer lane, and no slim player with
        // a heavyweight's throat.
        t.neck = uint8(K.NECK_OF_BUILD[t.build]);
        // Shading is indexed BY HEAD: each skull carries its own tonal planes.
        t.shading = t.head;

        // ---- CONSTRAINT PASS, identical to the JS reference. Every rule maps
        // to a STABLE alternative; none of them rerolls.
        uint256 hwBit = 1 << t.headwear;
        bool covers = hwBit & K.HEADWEAR_COVERS_MASK != 0;
        if (covers) t.hair = uint8(K.HAIR_FALLBACK[t.hair]);
        if (t.hair == 0 && hwBit & K.HEADWEAR_BAND_MASK != 0) t.headwear = 0;
        // An open mouth inside a full beard reads as a hole. Neutral, not
        // Stern: Stern is 6px and illegal on a narrow skull, which is how a
        // constraint pass quietly undoes the compatibility rule above it.
        if (t.beard >= 6 && t.mouth == 4) t.mouth = 0;
        if (t.beard >= 6 && t.collar == 3) t.collar = 0;
        if (t.ears == 2 && covers) t.ears = 1;
    }

    /// @dev The eligible lists are generated from the same function the
    /// reference renderer calls, so the rule exists in exactly one place.
    function _eligibleMouth(uint8 widthClass, uint256 laneValue) private pure returns (uint8) {
        bytes memory lens = K.MOUTH_ELIG_LEN;
        bytes memory elig = K.MOUTH_ELIG;
        uint256 start;
        for (uint256 k; k < widthClass; ++k) start += uint256(uint8(lens[k]));
        uint256 n = uint256(uint8(lens[widthClass]));
        if (n == 0) return 0;
        return uint8(elig[start + (laneValue % n)]);
    }
}
