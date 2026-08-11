// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only stand-in for a future SAIRI ERC-20. This is NOT the
/// real SAIRI token; the protocol makes no assumption about the eventual
/// contract address — governance simply configures it in FobalAssetRegistry.
contract MockSairi is ERC20 {
    constructor() ERC20("Mock SAIRI", "mSAIRI") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Fee-on-transfer token used ONLY to prove the protocol rejects
/// non-standard assets via balance-delta checks.
contract MockFeeOnTransferToken is ERC20 {
    constructor() ERC20("Mock FeeToken", "mFEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 burn = value / 100; // 1% transfer tax
            super._update(from, address(0), burn);
            super._update(from, to, value - burn);
        } else {
            super._update(from, to, value);
        }
    }
}
