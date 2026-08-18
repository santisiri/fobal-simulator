// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FobalRendererRouter} from "../../src/FobalRendererRouter.sol";

interface IPlayerLive {
    function renderer() external view returns (address);
    function nextTokenId() external view returns (uint256);
    function tokenURI(uint256) external view returns (string memory);
}

/// P1's acceptance proof, run against the REAL Base Sepolia deployment:
/// wrapping the live renderer in the router changes no output byte for any
/// token that exists. Skips itself when not forked, so CI never breaks.
///
///   forge test --match-contract RouterParityFork --fork-url https://sepolia.base.org
contract RouterParityForkTest is Test {
    // recovered from chain 2026-08-18; recorded nowhere in the repo before
    // this slice (see docs/ONCHAIN_DEPLOYMENTS.md)
    address constant PLAYER = 0x52F5828dA509D6043c2619F048687BEdfA4789d4;
    address constant LIVE_RENDERER = 0xB103DCe9f0A45c0FDE4d34AdB53836e9c43aB5dF;

    function test_routerIsByteIdenticalOnLiveTokens() public {
        if (block.chainid != 84532) {
            emit log("skipped: not forked onto Base Sepolia (84532)");
            return;
        }
        IPlayerLive live = IPlayerLive(PLAYER);
        assertEq(live.renderer(), LIVE_RENDERER, "live renderer moved; re-recover before deploying");

        FobalRendererRouter router = new FobalRendererRouter(address(this), LIVE_RENDERER);
        uint256 supply = live.nextTokenId();
        assertGt(supply, 1, "no tokens to compare");

        for (uint256 id = 1; id < supply; ++id) {
            assertEq(
                keccak256(bytes(router.tokenURI(id))),
                keccak256(bytes(live.tokenURI(id))),
                string.concat("router output differs for token ", vm.toString(id))
            );
        }
        emit log_named_uint("tokens proven byte-identical", supply - 1);
    }
}
