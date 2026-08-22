// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FobalArtConstants as K} from "./FobalArtConstants.sol";

/// @title FobalAnchors — where a face's features live on a given skull.
/// @notice Item 20's compact struct. FOUR integers per head are stored
/// (width, chin row, eye row, eye gap); the other ten anchors are DERIVED
/// here, byte-identically to packages/art/spec/anchors.js. Storing what can
/// be computed is how the two implementations drift apart.
///
/// Pure and total: an out-of-range head index clamps to head 0 rather than
/// reverting, because an anchor lookup must never be able to take tokenURI
/// down.
library FobalAnchors {
    struct Anchors {
        int16 headX;
        int16 headW;
        int16 top;
        int16 chinY;
        int16 eyeY;
        int16 leftEyeX;
        int16 rightEyeX;
        int16 browY;
        int16 noseY;
        int16 mouthY;
        int16 earY;
        int16 earLeftX;
        int16 earRightX;
        uint8 widthClass;
    }

    function anchorsOf(uint8 head) internal pure returns (Anchors memory a) {
        bytes memory g = K.HEAD_GEOM;
        uint256 n = g.length / 4;
        uint256 i = head < n ? head : 0;
        int16 w = int16(uint16(uint8(g[i * 4])));
        int16 chin = int16(uint16(uint8(g[i * 4 + 1])));
        int16 eyeY = int16(uint16(uint8(g[i * 4 + 2])));
        int16 gap = int16(uint16(uint8(g[i * 4 + 3])));

        int16 cx = int16(uint16(K.CX));
        int16 gapHalf = gap / 2; // >> 1 on a non-negative value
        a.headW = w;
        a.headX = cx - w / 2;
        a.top = int16(uint16(K.HEAD_TOP));
        a.chinY = chin;
        a.eyeY = eyeY;
        a.leftEyeX = cx - gapHalf - int16(uint16(K.EYE_W));
        a.rightEyeX = cx + gapHalf + (gap & 1);
        a.browY = eyeY - 3;
        a.noseY = eyeY + 2;
        a.mouthY = chin - 3;
        a.earY = eyeY;
        a.earLeftX = a.headX - 3;
        a.earRightX = a.headX + w - 1;
        a.widthClass = w <= 12 ? 0 : (w <= 14 ? 1 : 2);
    }
}
