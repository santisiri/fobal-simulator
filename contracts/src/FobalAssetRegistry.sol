// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title FobalAssetRegistry — money is configuration, not code.
/// @notice address(0) is native ETH; anything else is a governance-approved
/// ERC-20. A future SAIRI token becomes usable with one setAsset call.
/// Exotic tokens (fee-on-transfer, rebasing, hooks) are NOT supported: the
/// consuming contracts verify exact balance deltas and revert on any token
/// that does not move face value.
contract FobalAssetRegistry is AccessControl {
    bytes32 public constant ASSET_ADMIN_ROLE = keccak256("ASSET_ADMIN_ROLE");

    struct AssetConfig {
        bool enabled;
        uint96 minStake;
        uint96 maxStake;
        /// @dev Scales the progression policy's per-match caps in basis
        /// points (10_000 = 1x). Progression is still bounded by the signed
        /// result AND the protocol caps — this only sets the ceiling.
        uint32 progressionMultiplierBps;
    }

    mapping(address asset => AssetConfig) public assets;

    event PaymentAssetConfigured(
        address indexed asset, bool enabled, uint96 minStake, uint96 maxStake, uint32 progressionMultiplierBps
    );

    error AssetDisabled(address asset);
    error StakeOutOfRange(address asset, uint256 amount);
    error InvalidConfig(string reason);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ASSET_ADMIN_ROLE, admin);
    }

    function setAsset(address asset, AssetConfig calldata config) external onlyRole(ASSET_ADMIN_ROLE) {
        if (config.enabled && config.maxStake < config.minStake) revert InvalidConfig("min>max");
        if (config.enabled && config.progressionMultiplierBps > 100_000) revert InvalidConfig("multiplier");
        assets[asset] = config;
        emit PaymentAssetConfigured(
            asset, config.enabled, config.minStake, config.maxStake, config.progressionMultiplierBps
        );
    }

    function requireStakeAllowed(address asset, uint256 amount) external view returns (AssetConfig memory c) {
        c = assets[asset];
        if (!c.enabled) revert AssetDisabled(asset);
        if (amount < c.minStake || amount > c.maxStake) revert StakeOutOfRange(asset, amount);
    }

    function requireEnabled(address asset) external view {
        if (!assets[asset].enabled) revert AssetDisabled(asset);
    }

    function isEnabled(address asset) external view returns (bool) {
        return assets[asset].enabled;
    }

    function progressionMultiplierBps(address asset) external view returns (uint32) {
        return assets[asset].progressionMultiplierBps;
    }
}
