// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Versioned game-balance math, isolated so constants never scatter
/// through the protocol contracts. All values here are PROTOCOL invariants;
/// tunable POLICY caps live in FobalProgression's config.
library ProgressionMath {
    uint16 internal constant MAX_LEVEL = 99;

    /// @notice Level curve: level = 1 + floor(sqrt(xp / 100)), capped.
    /// 0 xp = L1, 100 xp = L2, 400 = L3, 900 = L4 ... quadratic cost per
    /// level keeps late levels meaningful without unbounded loops.
    function levelForXp(uint32 xp) internal pure returns (uint16) {
        uint256 level = 1 + Math.sqrt(uint256(xp) / 100);
        return level > MAX_LEVEL ? MAX_LEVEL : uint16(level);
    }
}
