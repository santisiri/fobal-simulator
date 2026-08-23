// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FobalArtLibrary} from "../../src/FobalArtLibrary.sol";
import {FobalArtConstants as K} from "../../src/art/FobalArtConstants.sol";
import {FobalFaceComposer} from "../../src/art/FobalFaceComposer.sol";
import {FobalKitComposer} from "../../src/art/FobalKitComposer.sol";
import {FobalKitRegistry} from "../../src/art/FobalKitRegistry.sol";
import {FobalRendererRouter} from "../../src/FobalRendererRouter.sol";
import {FobalRendererV2_1, IPlayerReader2} from "../../src/art/FobalRendererV2_1.sol";
import {FobalSquadRegistry, ITeamsRead, IOwnerOf} from "../../src/art/FobalSquadRegistry.sol";

interface IPlayerLive {
    function renderer() external view returns (address);
    function nextTokenId() external view returns (uint256);
    function tokenURI(uint256) external view returns (string memory);
    function setRenderer(address) external;
    function hasRole(bytes32, address) external view returns (bool);
    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);
}

/// THE WHOLE ROLLOUT, rehearsed against real Base Sepolia state.
///
/// docs/ART_ROLLOUT.md steps 1 to 6 in order, each with its rollback proven
/// before the next begins. Every step after this one costs real gas and moves
/// a pointer eleven people's metadata hangs off, so the sequence should have
/// been executed at least once somewhere it cannot hurt.
///
///   forge test --match-contract RolloutRehearsal \
///     --fork-url https://sepolia.base.org -vv
contract RolloutRehearsalTest is Test {
    address constant PLAYER = 0x52F5828dA509D6043c2619F048687BEdfA4789d4;
    address constant TEAMS = 0x22d6518ee6f80d9D772f56D52b0EA9E08A9aad90;
    address constant LIVE_RENDERER = 0xB103DCe9f0A45c0FDE4d34AdB53836e9c43aB5dF;
    address constant ADMIN = 0x26250e47500943464290A77ae3508a3001d9B69d;

    IPlayerLive live = IPlayerLive(PLAYER);

    function _name(bytes32 k) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && k[n] != 0) ++n;
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = k[i];
        return string(b);
    }

    function test_wholeRolloutInOrder() public {
        if (block.chainid != 84532) {
            emit log("skipped: not forked onto Base Sepolia (84532)");
            return;
        }
        require(live.hasRole(live.DEFAULT_ADMIN_ROLE(), ADMIN), "admin moved - update ONCHAIN_DEPLOYMENTS.md");
        uint256 supply = live.nextTokenId();
        assertGt(supply, 1, "no tokens to roll out to");

        bytes32[] memory v1 = new bytes32[](supply);
        for (uint256 id = 1; id < supply; ++id) v1[id] = keccak256(bytes(live.tokenURI(id)));
        emit log_named_uint("tokens live", supply - 1);

        // ---------------------------------------------------------- STEP 1
        FobalRendererRouter router = new FobalRendererRouter(ADMIN, LIVE_RENDERER);
        vm.prank(ADMIN);
        live.setRenderer(address(router));
        for (uint256 id = 1; id < supply; ++id) {
            assertEq(keccak256(bytes(live.tokenURI(id))), v1[id], "step 1 changed output");
        }
        emit log("step 1  router installed, output unchanged");

        // ---------------------------------------------------------- STEP 2
        FobalArtLibrary art = new FobalArtLibrary(address(this));
        bytes32[] memory names = K.classNames();
        uint256 rects;
        for (uint256 i; i < names.length; ++i) {
            string memory h =
                vm.readFile(string.concat(vm.projectRoot(), "/../packages/art/gen/blobs/", _name(names[i]), ".hex"));
            art.setClass(names[i], vm.parseBytes(vm.replace(h, "\n", "")));
        }
        for (uint256 i; i < names.length; ++i) {
            uint8 n = art.partCount(names[i]);
            assertGt(n, 0, "a class installed empty");
            for (uint8 p; p < n; ++p) rects += art.part(names[i], p).length;
        }
        emit log_named_uint("step 2  classes installed", names.length);
        emit log_named_uint("        rects read back", rects);
        // installing the atlas must not have touched a single token
        for (uint256 id = 1; id < supply; ++id) {
            assertEq(keccak256(bytes(live.tokenURI(id))), v1[id], "step 2 was not inert");
        }

        // ---------------------------------------------------------- STEP 3
        FobalSquadRegistry squads = new FobalSquadRegistry(IOwnerOf(PLAYER), ITeamsRead(TEAMS));
        FobalKitRegistry wardrobe = new FobalKitRegistry(ITeamsRead(TEAMS));
        FobalRendererV2_1 v2 = new FobalRendererV2_1(
            IPlayerReader2(PLAYER), new FobalFaceComposer(art), new FobalKitComposer(), squads, wardrobe
        );
        // functional standalone, against the LIVE collection's own tokens
        bytes32[] memory v2hash = new bytes32[](supply);
        for (uint256 id = 1; id < supply; ++id) {
            string memory uri = v2.tokenURI(id);
            assertGt(bytes(uri).length, 200, "v2 produced nothing for a live token");
            v2hash[id] = keccak256(bytes(uri));
            assertTrue(v2hash[id] != v1[id], "v2 must actually differ from v1");
        }
        emit log("step 3  renderer stack deployed and rendering every live token");
        for (uint256 id = 1; id < supply; ++id) {
            assertEq(keccak256(bytes(live.tokenURI(id))), v1[id], "step 3 was not inert");
        }

        // ---------------------------------------------------------- STEP 4
        vm.prank(ADMIN);
        router.pin(1, address(v2));
        assertEq(keccak256(bytes(live.tokenURI(1))), v2hash[1], "canary did not switch");
        for (uint256 id = 2; id < supply; ++id) {
            assertEq(keccak256(bytes(live.tokenURI(id))), v1[id], "canary leaked past token 1");
        }
        emit log("step 4  token 1 on v2, tokens 2+ untouched");

        vm.prank(ADMIN);
        router.pin(1, address(0));
        assertEq(keccak256(bytes(live.tokenURI(1))), v1[1], "canary rollback failed");
        emit log("        rollback proven, re-pinning");
        vm.prank(ADMIN);
        router.pin(1, address(v2));

        // ---------------------------------------------------------- STEP 5
        vm.prank(ADMIN);
        router.setCohort(1, supply - 1, address(v2));
        for (uint256 id = 1; id < supply; ++id) {
            assertEq(keccak256(bytes(live.tokenURI(id))), v2hash[id], "cohort missed a token");
        }
        emit log("step 5  whole cohort on v2");

        vm.prank(ADMIN);
        router.clearCohorts();
        for (uint256 id = 2; id < supply; ++id) {
            assertEq(keccak256(bytes(live.tokenURI(id))), v1[id], "cohort rollback failed");
        }
        emit log("        rollback proven, re-applying");
        vm.prank(ADMIN);
        router.setCohort(1, supply - 1, address(v2));

        // ---------------------------------------------------------- STEP 6
        vm.prank(ADMIN);
        router.setDefaultRenderer(address(v2));
        for (uint256 id = 1; id < supply; ++id) {
            assertEq(keccak256(bytes(live.tokenURI(id))), v2hash[id], "default did not take");
        }
        // the refresh: re-installing the address already installed, to re-emit
        vm.prank(ADMIN);
        live.setRenderer(address(router));
        emit log("step 6  default switched and refresh re-emitted");

        // ------------------------------------------------- ALL THE WAY BACK
        vm.prank(ADMIN);
        live.setRenderer(LIVE_RENDERER);
        for (uint256 id = 1; id < supply; ++id) {
            assertEq(keccak256(bytes(live.tokenURI(id))), v1[id], "the one-call undo did not restore v1");
        }
        emit log("undo    setRenderer(v1) restores every token byte-for-byte");
    }

    /// What it costs to read a token once the new art is live.
    function test_reportLiveGas() public {
        if (block.chainid != 84532) return;
        FobalArtLibrary art = new FobalArtLibrary(address(this));
        bytes32[] memory names = K.classNames();
        for (uint256 i; i < names.length; ++i) {
            string memory h =
                vm.readFile(string.concat(vm.projectRoot(), "/../packages/art/gen/blobs/", _name(names[i]), ".hex"));
            art.setClass(names[i], vm.parseBytes(vm.replace(h, "\n", "")));
        }
        FobalRendererV2_1 v2 = new FobalRendererV2_1(
            IPlayerReader2(PLAYER),
            new FobalFaceComposer(art),
            new FobalKitComposer(),
            new FobalSquadRegistry(IOwnerOf(PLAYER), ITeamsRead(TEAMS)),
            new FobalKitRegistry(ITeamsRead(TEAMS))
        );
        uint256 supply = live.nextTokenId();
        uint256 total;
        uint256 worst;
        for (uint256 id = 1; id < supply; ++id) {
            uint256 before = gasleft();
            v2.tokenURI(id);
            uint256 used = before - gasleft();
            total += used;
            if (used > worst) worst = used;
        }
        emit log_named_uint("mean tokenURI gas on live tokens", total / (supply - 1));
        emit log_named_uint("worst", worst);
        assertLt(worst, 4_000_000, "a live token must stay well inside eth_call budgets");
    }
}
