// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FobalRendererRouter} from "../../src/FobalRendererRouter.sol";
import {IFobalRenderer} from "../../src/interfaces/IFobalRenderer.sol";

interface IPlayerLive {
    function renderer() external view returns (address);
    function nextTokenId() external view returns (uint256);
    function tokenURI(uint256) external view returns (string memory);
    function setRenderer(address) external;
    function hasRole(bytes32, address) external view returns (bool);
    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);
}

/// A DRESS REHEARSAL of docs/ROUTER_INSTALL.md, against real Base Sepolia
/// state. The existing fork test proves step 2 only — that wrapping the live
/// renderer changes no bytes. This runs the whole sequence, including the one
/// step that actually writes storage and the rollback that undoes it, so the
/// first time `setRenderer` is called for real is not the first time anyone
/// has seen it happen.
///
///   forge test --match-contract RouterInstallRehearsal \
///     --fork-url https://sepolia.base.org -vvv
contract RouterInstallRehearsalTest is Test {
    address constant PLAYER = 0x52F5828dA509D6043c2619F048687BEdfA4789d4;
    address constant LIVE_RENDERER = 0xB103DCe9f0A45c0FDE4d34AdB53836e9c43aB5dF;
    /// the account that can perform step 5, per docs/ONCHAIN_DEPLOYMENTS.md —
    /// asserted against chain below, because a doc is not a source of truth
    /// for the one key that can move the collection's only mutable pointer
    address constant ADMIN = 0x26250e47500943464290A77ae3508a3001d9B69d;

    event RendererChanged(address indexed renderer, string version);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    IPlayerLive live = IPlayerLive(PLAYER);

    function _forked() internal returns (bool) {
        if (block.chainid != 84532) {
            emit log("skipped: not forked onto Base Sepolia (84532)");
            return false;
        }
        return true;
    }

    /// Steps 1 to 6, in order, with the undo proven at the end.
    function test_fullInstallSequence() public {
        if (!_forked()) return;

        // ---- STEP 1: prove the current pointer. Never trust a doc for a
        // rollback target; this address IS the undo button.
        address current = live.renderer();
        assertEq(current, LIVE_RENDERER, "live renderer moved - re-record it before deploying");
        uint256 supply = live.nextTokenId();
        assertGt(supply, 1, "no tokens to compare");
        emit log_named_address("step 1  current renderer", current);
        emit log_named_uint("        tokens live", supply - 1);

        // record every token's output BEFORE anything changes
        bytes32[] memory before = new bytes32[](supply);
        for (uint256 id = 1; id < supply; ++id) {
            before[id] = keccak256(bytes(live.tokenURI(id)));
        }

        // ---- STEP 3: deploy the router. It reads the live pointer itself, so
        // it cannot be wired to a stale address.
        FobalRendererRouter router = new FobalRendererRouter(address(this), current);
        assertEq(router.defaultRenderer(), current, "router default lane");
        assertEq(router.fallbackRenderer(), current, "router fallback lane");
        emit log_named_address("step 3  router deployed", address(router));

        // ---- STEP 4: prove the deployed instance, token by token
        for (uint256 id = 1; id < supply; ++id) {
            assertEq(keccak256(bytes(router.tokenURI(id))), before[id],
                string.concat("router differs from live for token ", vm.toString(id)));
        }
        emit log_named_uint("step 4  proven through router", supply - 1);

        // ---- STEP 5: install. The only state-changing step.
        address admin = _findAdmin();
        emit log_named_address("step 5  installing as", admin);

        vm.expectEmit(true, false, false, false, PLAYER);
        emit RendererChanged(address(router), "");
        vm.expectEmit(false, false, false, true, PLAYER);
        emit BatchMetadataUpdate(1, supply - 1);

        uint256 gasBefore = gasleft();
        vm.prank(admin);
        live.setRenderer(address(router));
        emit log_named_uint("        install gas", gasBefore - gasleft());
        assertEq(live.renderer(), address(router), "pointer did not move");

        // ---- STEP 6: output did not change by a byte, read through the
        // COLLECTION now rather than through the router directly
        for (uint256 id = 1; id < supply; ++id) {
            assertEq(keccak256(bytes(live.tokenURI(id))), before[id],
                string.concat("output changed after install for token ", vm.toString(id)));
        }
        emit log_named_uint("step 6  unchanged after install", supply - 1);

        // ---- ROLLBACK: the undo must work, and restore byte-for-byte
        vm.prank(admin);
        live.setRenderer(current);
        assertEq(live.renderer(), current, "rollback did not restore the pointer");
        for (uint256 id = 1; id < supply; ++id) {
            assertEq(keccak256(bytes(live.tokenURI(id))), before[id], "rollback changed output");
        }
        emit log("rollback  restored, byte-identical");
    }

    /// The property the router exists for: with it installed, a renderer that
    /// reverts on every call must NOT take metadata down.
    function test_installedRouterSurvivesABrokenRenderer() public {
        if (!_forked()) return;
        address current = live.renderer();
        uint256 supply = live.nextTokenId();
        address admin = _findAdmin();

        FobalRendererRouter router = new FobalRendererRouter(address(this), current);
        vm.prank(admin);
        live.setRenderer(address(router));

        // point the DEFAULT lane at something that always reverts, leaving the
        // fallback lane on the good renderer — the shape of a bad art deploy
        router.setDefaultRenderer(address(new AlwaysReverts()));

        for (uint256 id = 1; id < supply; ++id) {
            string memory uri = live.tokenURI(id);
            assertGt(bytes(uri).length, 0, "a broken renderer must degrade, not revert");
        }
        emit log("broken default renderer: every token still resolves");

        // and with BOTH lanes broken, the inline card still answers
        router.setFallbackRenderer(address(new AlwaysReverts()));
        for (uint256 id = 1; id < supply; ++id) {
            assertGt(bytes(live.tokenURI(id)).length, 0, "the inline card must always answer");
        }
        emit log("both lanes broken: inline identity card answers");
    }

    /// @dev the account that can actually perform step 5, VERIFIED on chain
    function _findAdmin() internal view returns (address) {
        require(live.hasRole(live.DEFAULT_ADMIN_ROLE(), ADMIN),
            "admin role moved off the recorded address - update docs/ONCHAIN_DEPLOYMENTS.md before installing");
        return ADMIN;
    }
}

contract AlwaysReverts is IFobalRenderer {
    error Nope();

    function version() external pure returns (string memory) {
        return "always-reverts";
    }

    function tokenURI(uint256) external pure returns (string memory) {
        revert Nope();
    }
}
