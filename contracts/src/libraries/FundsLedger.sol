// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FundsLedger — pull-payments for every outbound transfer.
/// @notice Settlements and sales CREDIT balances; `withdraw` is the only
/// function that moves value out. Nobody's receive() hook can brick a
/// settlement, and conservation of value is a checkable invariant: for every
/// asset, contract balance == sum of credited, un-withdrawn entries (+ any
/// stakes still in open matches, in the escrow's case).
abstract contract FundsLedger is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice account => asset (address(0) = ETH) => withdrawable amount.
    mapping(address account => mapping(address asset => uint256)) public withdrawable;

    event FundsCredited(address indexed account, address indexed asset, uint256 amount);
    event FundsWithdrawn(address indexed account, address indexed asset, uint256 amount);

    error NothingToWithdraw(address asset);
    error EthTransferFailed();
    error UnexpectedEthValue();
    error NonStandardToken(address asset);

    function _credit(address account, address asset, uint256 amount) internal {
        if (amount == 0) return;
        withdrawable[account][asset] += amount;
        emit FundsCredited(account, asset, amount);
    }

    /// @notice Withdraw the caller's full balance for one asset.
    function withdraw(address asset) external nonReentrant {
        uint256 amount = withdrawable[msg.sender][asset];
        if (amount == 0) revert NothingToWithdraw(asset);
        withdrawable[msg.sender][asset] = 0;
        if (asset == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(asset).safeTransfer(msg.sender, amount);
        }
        emit FundsWithdrawn(msg.sender, asset, amount);
    }

    /// @dev Pull EXACTLY `amount` of `asset` from `from`. ETH must arrive as
    /// msg.value; ERC-20s are balance-delta checked so fee-on-transfer and
    /// rebasing tokens revert instead of corrupting accounting.
    function _pullExact(address asset, address from, uint256 amount) internal {
        if (asset == address(0)) {
            if (msg.value != amount) revert UnexpectedEthValue();
        } else {
            if (msg.value != 0) revert UnexpectedEthValue();
            uint256 before = IERC20(asset).balanceOf(address(this));
            IERC20(asset).safeTransferFrom(from, address(this), amount);
            if (IERC20(asset).balanceOf(address(this)) - before != amount) {
                revert NonStandardToken(asset);
            }
        }
    }
}
