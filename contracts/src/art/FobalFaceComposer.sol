// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FobalArtLibrary} from "../FobalArtLibrary.sol";
import {FobalArtConstants as K} from "./FobalArtConstants.sol";
import {FobalAnchors} from "./FobalAnchors.sol";
import {FobalTraitEngine as TE} from "./FobalTraitEngine.sol";
import {SvgNum} from "./SvgNum.sol";

/// @title FobalFaceComposer — draws WHO a player is.
/// @notice Takes a TraitVector and a palette. It has NO parameter for a kit,
/// a team, or a token id, so "a transfer changes the jersey, not the face" is
/// enforced by the type signature rather than by a code-review convention.
///
/// Face parts are stored ONCE, in local space, and translated onto the chosen
/// head's anchors. Six skulls therefore give six facial architectures — eye
/// spacing, brow line, nose and mouth heights, ear line all move — without a
/// single extra byte of atlas.
contract FobalFaceComposer {
    FobalArtLibrary public immutable art;

    // class ids, in the atlas order gen-art.mjs writes CLASS_ATTACH in
    uint256 private constant C_HEADS = 0;
    uint256 private constant C_SHADING = 1;
    uint256 private constant C_EARS = 2;
    uint256 private constant C_EYES = 3;
    uint256 private constant C_BROWS = 4;
    uint256 private constant C_NOSES = 5;
    uint256 private constant C_MOUTHS = 6;
    uint256 private constant C_BEARDS = 7;
    uint256 private constant C_HAIR = 8;
    uint256 private constant C_HEADWEAR = 9;
    uint256 private constant C_NECKS = 10;
    uint256 private constant C_BUILDS = 11;
    uint256 private constant C_COLLARS = 12;

    bytes32 private constant N_HEADS = bytes32("HEADS");
    bytes32 private constant N_SHADING = bytes32("SHADING");
    bytes32 private constant N_EARS = bytes32("EARS");
    bytes32 private constant N_EYES = bytes32("EYES");
    bytes32 private constant N_BROWS = bytes32("BROWS");
    bytes32 private constant N_NOSES = bytes32("NOSES");
    bytes32 private constant N_MOUTHS = bytes32("MOUTHS");
    bytes32 private constant N_BEARDS = bytes32("BEARDS");
    bytes32 private constant N_HAIR = bytes32("HAIR");
    bytes32 private constant N_HEADWEAR = bytes32("HEADWEAR");
    bytes32 private constant N_NECKS = bytes32("NECKS");
    bytes32 private constant N_BUILDS = bytes32("BUILDS");
    bytes32 private constant N_COLLARS = bytes32("COLLARS");

    // attach modes, matching the ATTACH table in gen-art.mjs
    uint8 private constant AT_ABS = 0;
    uint8 private constant AT_EYES = 1;
    uint8 private constant AT_BROWS = 2;
    uint8 private constant AT_EARS = 3;
    uint8 private constant AT_NOSE = 4;
    uint8 private constant AT_MOUTH = 5;
    uint8 private constant AT_CHIN = 6;
    uint8 private constant AT_TOP = 7;

    constructor(FobalArtLibrary artLibrary) {
        art = artLibrary;
    }

    /// @notice The shoulders, drawn BEFORE the kit pattern is painted into
    /// them. Build is body geometry — the kit fills it, and never the reverse.
    function build(TE.Traits memory t, bytes3[12] memory pal) external view returns (string memory) {
        FobalAnchors.Anchors memory a = FobalAnchors.anchorsOf(t.head);
        return _place(N_BUILDS, C_BUILDS, t.build, a, pal);
    }

    /// @notice Neck and collar, drawn after the pattern and before the face.
    function neckAndCollar(TE.Traits memory t, bytes3[12] memory pal) external view returns (string memory) {
        FobalAnchors.Anchors memory a = FobalAnchors.anchorsOf(t.head);
        return string.concat(
            _place(N_NECKS, C_NECKS, t.neck, a, pal), _place(N_COLLARS, C_COLLARS, t.collar, a, pal)
        );
    }

    /// @notice Every identity layer, in the reference renderer's order.
    /// @dev Accumulated rather than concatenated in one expression: ten live
    /// string temporaries put the IR optimiser over the stack limit.
    function identity(TE.Traits memory t, bytes3[12] memory pal) external view returns (string memory out) {
        FobalAnchors.Anchors memory a = FobalAnchors.anchorsOf(t.head);
        out = _place(N_HEADS, C_HEADS, t.head, a, pal);
        out = string.concat(out, _place(N_SHADING, C_SHADING, t.shading, a, pal));
        out = string.concat(out, _place(N_EARS, C_EARS, t.ears, a, pal));
        out = string.concat(out, _place(N_NOSES, C_NOSES, t.nose, a, pal));
        out = string.concat(out, _place(N_EYES, C_EYES, t.eyes, a, pal));
        out = string.concat(out, _place(N_BROWS, C_BROWS, t.brows, a, pal));
        out = string.concat(out, _place(N_MOUTHS, C_MOUTHS, t.mouth, a, pal));
        out = string.concat(out, _place(N_BEARDS, C_BEARDS, t.beard, a, pal));
        out = string.concat(out, _place(N_HAIR, C_HAIR, t.hair, a, pal));
        out = string.concat(out, _place(N_HEADWEAR, C_HEADWEAR, t.headwear, a, pal));
    }

    /// @dev A class the library does not know yet contributes nothing rather
    /// than reverting — a half-installed atlas must degrade, not deny.
    function _place(
        bytes32 className,
        uint256 classId,
        uint8 index,
        FobalAnchors.Anchors memory a,
        bytes3[12] memory pal
    ) private view returns (string memory out) {
        try art.part(className, index) returns (FobalArtLibrary.Rect[] memory rects) {
            uint8 mode = uint8(K.CLASS_ATTACH[classId]);
            if (mode == AT_TOP) return _emitClamped(rects, a, pal);
            out = _emitSide(rects, mode, a, pal, false);
            if (uint8(K.CLASS_MIRROR[classId]) != 0) {
                out = string.concat(out, _emitSide(rects, mode, a, pal, true));
            }
        } catch {
            return "";
        }
    }

    function _emitSide(
        FobalArtLibrary.Rect[] memory rects,
        uint8 mode,
        FobalAnchors.Anchors memory a,
        bytes3[12] memory pal,
        bool right
    ) private pure returns (string memory) {
        (int16 dx, int16 dy) = _origin(mode, a, right);
        if (!right) return _emit(rects, dx, dy, pal);
        // the mirror box is the class's own width; ears are the only class
        // whose box differs from the eye width
        int16 boxW = mode == AT_EARS ? int16(uint16(K.EAR_W)) : int16(uint16(K.EYE_W));
        return _emitMirrored(rects, dx, dy, boxW, pal);
    }

    /// @dev The translation for one attach mode; `right` selects the mirrored
    /// side's origin for the two-sided classes.
    function _origin(uint8 mode, FobalAnchors.Anchors memory a, bool right)
        private
        pure
        returns (int16 dx, int16 dy)
    {
        int16 cx = int16(uint16(K.CX));
        if (mode == AT_EYES) return (right ? a.rightEyeX : a.leftEyeX, a.eyeY);
        if (mode == AT_BROWS) return (right ? a.rightEyeX : a.leftEyeX, a.browY);
        if (mode == AT_EARS) return (right ? a.earRightX : a.earLeftX, a.earY);
        if (mode == AT_NOSE) return (cx, a.noseY);
        if (mode == AT_MOUTH) return (cx, a.mouthY);
        if (mode == AT_CHIN) return (cx, a.chinY);
        if (mode == AT_TOP) return (cx, a.top);
        return (0, 0); // AT_ABS
    }

    function _emit(FobalArtLibrary.Rect[] memory rects, int16 dx, int16 dy, bytes3[12] memory pal)
        private
        pure
        returns (string memory out)
    {
        for (uint256 i; i < rects.length; ++i) {
            out = string.concat(out, _rect(_moved(rects[i], rects[i].x + dx, rects[i].y + dy, rects[i].w), pal));
        }
    }

    /// @dev Right-hand parts are the LEFT art reflected inside a box of the
    /// class's own width, so an angled brow pair converges and the right ear
    /// faces outward — from one stored copy.
    function _emitMirrored(
        FobalArtLibrary.Rect[] memory rects,
        int16 dx,
        int16 dy,
        int16 boxW,
        bytes3[12] memory pal
    ) private pure returns (string memory out) {
        for (uint256 i; i < rects.length; ++i) {
            int16 mx = boxW - rects[i].x - int16(uint16(rects[i].w)) + dx;
            out = string.concat(out, _rect(_moved(rects[i], mx, rects[i].y + dy, rects[i].w), pal));
        }
    }

    /// @dev Item 11 — hair follows head geometry. Caps are authored against
    /// the WIDEST skull; on a narrow one the overhang would be a quarter of
    /// the head. Clipping to the skull +/- 2 makes one authored cap fit all
    /// six. A rect clipped to nothing is DROPPED, so a zero-width rect can
    /// never reach the SVG.
    function _emitClamped(FobalArtLibrary.Rect[] memory rects, FobalAnchors.Anchors memory a, bytes3[12] memory pal)
        private
        pure
        returns (string memory out)
    {
        int16 cx = int16(uint16(K.CX));
        int16 lo = a.headX - cx - 2;
        int16 hi = a.headX + a.headW - cx + 2;
        for (uint256 i; i < rects.length; ++i) {
            int16 x1 = rects[i].x + int16(uint16(rects[i].w));
            int16 x0 = rects[i].x < lo ? lo : rects[i].x;
            if (x1 > hi) x1 = hi;
            if (x1 <= x0) continue;
            out = string.concat(
                out, _rect(_moved(rects[i], x0 + cx, rects[i].y + a.top, uint8(uint16(x1 - x0))), pal)
            );
        }
    }

    /// @dev A COPY with new placement. `Rect memory r = rects[i]` aliases the
    /// array element, so translating in place corrupted the source art for
    /// every later pass — which is exactly how the right ear ended up drawn
    /// at twice the eye height. Never mutate a part; move a copy of it.
    function _moved(FobalArtLibrary.Rect memory src, int16 x, int16 y, uint8 w)
        private
        pure
        returns (FobalArtLibrary.Rect memory)
    {
        return FobalArtLibrary.Rect({x: x, y: y, w: w, h: src.h, slot: src.slot});
    }

    /// @dev The exact byte shape the JS reference emits. Emitted as two
    /// halves: with placement now living in this contract, the single
    /// eleven-argument concat put the IR optimiser over the stack limit.
    function _rect(FobalArtLibrary.Rect memory r, bytes3[12] memory pal) private pure returns (string memory) {
        return string.concat(_xy(r), _wh(r, pal));
    }

    function _xy(FobalArtLibrary.Rect memory r) private pure returns (string memory) {
        return string.concat('<rect x="', SvgNum.i(r.x), '" y="', SvgNum.i(r.y), '"');
    }

    function _wh(FobalArtLibrary.Rect memory r, bytes3[12] memory pal) private pure returns (string memory) {
        return string.concat(
            ' width="', SvgNum.u(r.w), '" height="', SvgNum.u(r.h),
            '" fill="#', SvgNum.color(pal[r.slot < 12 ? r.slot : 0]), '"/>'
        );
    }

    /// @notice Kept for the parity harness, which asserts rect byte shape
    /// independently of placement.
    function rect(FobalArtLibrary.Rect memory r, bytes3[12] memory pal) public pure returns (string memory) {
        return _rect(r, pal);
    }
}
