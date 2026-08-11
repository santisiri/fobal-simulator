// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IFobalRenderer {
    function tokenURI(uint256 tokenId) external view returns (string memory);
    function version() external pure returns (string memory);
}
