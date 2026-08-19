// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Number and colour formatting for SVG output.
/// @dev Byte-identical parity with the JS reference depends on formatting
/// agreeing exactly: no leading zeros, a bare "-" for negatives, lowercase
/// hex for colours. OZ's Strings is not used in the hot path — a 0..255 LUT
/// is both cheaper and impossible to disagree with JS about.
library SvgNum {
    bytes16 private constant HEX = "0123456789abcdef";

    function u(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory b = new bytes(len);
        while (v != 0) {
            b[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }

    /// @dev JS emits `-1` for negative coordinates; so do we.
    function i(int256 v) internal pure returns (string memory) {
        if (v < 0) return string.concat("-", u(uint256(-v)));
        return u(uint256(v));
    }

    /// @dev lowercase 6-digit hex, matching the JS palette literals
    function color(bytes3 c) internal pure returns (string memory) {
        bytes memory out = new bytes(6);
        for (uint256 k; k < 3; ++k) {
            uint8 byteVal = uint8(c[k]);
            out[k * 2] = HEX[byteVal >> 4];
            out[k * 2 + 1] = HEX[byteVal & 0x0f];
        }
        return string(out);
    }
}
