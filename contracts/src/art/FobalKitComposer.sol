// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FobalArtConstants as K} from "./FobalArtConstants.sol";
import {SvgNum} from "./SvgNum.sol";

/// @title FobalKitComposer — draws WHAT a player wears.
/// @notice The mirror of FobalFaceComposer: that one has no kit parameter,
/// this one has no dna, appearance or trait parameter. It is handed a torso
/// BOX — an x and a width, pure geometry — and paints inside it. Neither
/// contract can reach into the other's half of the picture, so "a transfer
/// changes the jersey, not the face" holds by construction rather than by
/// discipline.
///
/// Patterns are sized for the EIGHT rows a 32px bust actually has: 3px
/// stripes and 2px hoops, never 1px alternation, which is noise at 48px.
contract FobalKitComposer {
    struct Kit {
        uint24 primary;
        uint24 secondary;
        uint24 accent;
        uint8 pattern;
    }

    uint256 private constant PATTERN_Y = 25;

    function _r(int256 x, int256 y, uint256 w, uint256 h, bytes3 fill) private pure returns (string memory) {
        return string.concat(
            '<rect x="', SvgNum.i(x), '" y="', SvgNum.i(y),
            '" width="', SvgNum.u(w), '" height="', SvgNum.u(h),
            '" fill="#', SvgNum.color(fill), '"/>'
        );
    }

    /// @notice The pattern only. The torso itself belongs to the player's
    /// build, which is body geometry, not clothing.
    /// @param x0 left edge of the torso box
    /// @param w width of the torso box
    function kitLayer(Kit memory kit, uint256 x0, uint256 w) external pure returns (string memory out) {
        bytes3 s = bytes3(kit.secondary);
        int256 x = int256(x0);
        int256 y = int256(PATTERN_Y);
        uint256 half = w >> 1;

        if (kit.pattern == 1) {
            // sleeves
            out = string.concat(_r(x, y, 3, 7, s), _r(x + int256(w) - 3, y, 3, 7, s));
        } else if (kit.pattern == 2) {
            // stripes: 3px wide, 6px pitch
            for (uint256 i; i < 4; ++i) out = string.concat(out, _r(x + int256(2 + i * 6), y, 3, 7, s));
        } else if (kit.pattern == 3) {
            // hoops: 2px, and only two of them
            out = string.concat(_r(x, y + 1, w, 2, s), _r(x, y + 5, w, 2, s));
        } else if (kit.pattern == 4) {
            out = string.concat(out, _r(x + int256(half), y, w - half, 7, s));
        } else if (kit.pattern == 5) {
            // sash
            for (uint256 i; i < 7; ++i) out = string.concat(out, _r(x + int256(3 + i * 2), y + int256(i), 5, 1, s));
        } else if (kit.pattern == 6) {
            // chevron
            for (uint256 i; i < 4; ++i) {
                out = string.concat(
                    out,
                    _r(x + int256(half) - 4 + int256(i), y + 1 + int256(i), 4, 1, s),
                    _r(x + int256(half) + int256(i), y + 1 + int256(i), 4, 1, s)
                );
            }
        }
        // pattern 0 is Solid: the build's own torso rect is the whole kit
    }
}
