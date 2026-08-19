// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FobalArtConstants as K} from "./FobalArtConstants.sol";
import {SvgNum} from "./SvgNum.sol";

/// @title FobalKitComposer — draws WHAT a player wears.
/// @notice The mirror of FobalFaceComposer: that one has no kit parameter,
/// this one has no dna, appearance or trait parameter. Neither can reach into
/// the other's half of the picture, so "a transfer changes the jersey, not
/// the face" holds by construction rather than by discipline.
contract FobalKitComposer {
    struct Kit {
        uint24 primary;
        uint24 secondary;
        uint24 accent;
        uint8 pattern;
    }

    function _r(int256 x, int256 y, uint256 w, uint256 h, bytes3 fill) private pure returns (string memory) {
        return string.concat(
            '<rect x="', SvgNum.i(x), '" y="', SvgNum.i(y),
            '" width="', SvgNum.u(w), '" height="', SvgNum.u(h),
            '" fill="#', SvgNum.color(fill), '"/>'
        );
    }

    /// @param playerAccent the PLAYER's colour, not the club's — collar and
    /// cuffs keep eleven people distinguishable inside one kit.
    function kitLayer(Kit memory kit, bytes3 playerAccent) external pure returns (string memory out) {
        bytes3 p = bytes3(kit.primary);
        bytes3 s = bytes3(kit.secondary);
        int256 y = 24;
        out = string.concat(_r(0, y - 1, 32, 1, K.INK), _r(2, y, 28, 8, p));
        if (kit.pattern == 1) {
            out = string.concat(out, _r(2, y, 5, 8, s), _r(25, y, 5, 8, s));
        } else if (kit.pattern == 2) {
            for (uint256 i; i < 5; ++i) out = string.concat(out, _r(int256(4 + i * 6), y, 3, 8, s));
        } else if (kit.pattern == 3) {
            out = string.concat(out, _r(2, y + 2, 28, 2, s), _r(2, y + 6, 28, 2, s));
        } else if (kit.pattern == 4) {
            out = string.concat(out, _r(16, y, 14, 8, s));
        } else if (kit.pattern == 5) {
            for (uint256 i; i < 8; ++i) out = string.concat(out, _r(int256(6 + i * 2), y + int256(i), 4, 1, s));
        } else if (kit.pattern == 6) {
            for (uint256 i; i < 4; ++i) {
                out = string.concat(
                    out,
                    _r(14 - int256(i * 2), y + 2 + int256(i), 3, 1, s),
                    _r(16 + int256(i * 2), y + 2 + int256(i), 3, 1, s)
                );
            }
        }
        out = string.concat(
            out,
            _r(12, y, 8, 2, playerAccent),
            _r(2, y + 6, 3, 2, playerAccent),
            _r(27, y + 6, 3, 2, playerAccent),
            _r(13, y, 6, 1, K.INK)
        );
    }
}
