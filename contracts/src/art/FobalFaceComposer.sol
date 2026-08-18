// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FobalArtLibrary} from "../FobalArtLibrary.sol";
import {FobalTraitEngine as TE} from "./FobalTraitEngine.sol";
import {SvgNum} from "./SvgNum.sol";

/// @title FobalFaceComposer — draws WHO a player is.
/// @notice Takes a TraitVector and a palette. It has NO parameter for a kit,
/// a team, or a token id, so "a transfer changes the jersey, not the face" is
/// enforced by the type signature rather than by a code-review convention.
contract FobalFaceComposer {
    FobalArtLibrary public immutable art;

    bytes32 private constant HEADS = bytes32("HEADS");
    bytes32 private constant NOSES = bytes32("NOSES");
    bytes32 private constant EYES = bytes32("EYES");
    bytes32 private constant BROWS = bytes32("BROWS");
    bytes32 private constant MOUTHS = bytes32("MOUTHS");
    bytes32 private constant BEARDS = bytes32("BEARDS");
    bytes32 private constant HAIR = bytes32("HAIR");
    bytes32 private constant HEADWEAR = bytes32("HEADWEAR");

    constructor(FobalArtLibrary artLibrary) {
        art = artLibrary;
    }

    /// @notice Every identity layer, in the reference renderer's order.
    function identity(TE.Traits memory t, bytes3[12] memory pal) external view returns (string memory) {
        return string.concat(
            _class(HEADS, t.head, pal),
            _class(NOSES, t.nose, pal),
            _class(EYES, t.eyes, pal),
            _class(BROWS, t.brows, pal),
            _class(MOUTHS, t.mouth, pal),
            _class(BEARDS, t.beard, pal),
            _class(HAIR, t.hair, pal),
            _class(HEADWEAR, t.headwear, pal)
        );
    }

    /// @dev A class the library does not know yet contributes nothing rather
    /// than reverting — a half-installed atlas must degrade, not deny.
    function _class(bytes32 className, uint8 index, bytes3[12] memory pal)
        private
        view
        returns (string memory out)
    {
        try art.part(className, index) returns (FobalArtLibrary.Rect[] memory rects) {
            for (uint256 i; i < rects.length; ++i) {
                out = string.concat(out, rect(rects[i], pal));
            }
        } catch {
            return "";
        }
    }

    /// @dev The exact byte shape the JS reference emits.
    function rect(FobalArtLibrary.Rect memory r, bytes3[12] memory pal) public pure returns (string memory) {
        return string.concat(
            '<rect x="',
            SvgNum.i(r.x),
            '" y="',
            SvgNum.i(r.y),
            '" width="',
            SvgNum.u(r.w),
            '" height="',
            SvgNum.u(r.h),
            '" fill="#',
            SvgNum.color(pal[r.slot < 12 ? r.slot : 0]),
            '"/>'
        );
    }
}
