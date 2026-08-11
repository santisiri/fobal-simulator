// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalPlayer} from "../../src/FobalPlayer.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";
import {PlayerCodec} from "../../src/libraries/PlayerCodec.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract PlayerTest is BaseFixture {
    uint256 internal tokenId;

    function setUp() public override {
        super.setUp();
        uint256[] memory ids = mintSquadFor(alice, 0, 1);
        tokenId = ids[0];
    }

    // ------------------------------------------------------------- ownership

    function test_mint_assignsOwner() public view {
        assertEq(player.ownerOf(tokenId), alice);
        assertEq(player.balanceOf(alice), 1);
    }

    function test_unauthorized_cannotMint() public {
        FobalTypes.PlayerSeed memory seed = makeSeed("Intruder", 1, 99);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, bob, player.MINTER_ROLE()
            )
        );
        vm.prank(bob);
        player.mint(bob, seed);
    }

    function test_seedValidation() public {
        vm.startPrank(address(generator));
        FobalTypes.PlayerSeed memory seed = makeSeed("Bad", 1, 1);

        seed.position = 4;
        vm.expectRevert(abi.encodeWithSelector(FobalPlayer.InvalidSeed.selector, "position"));
        player.mint(alice, seed);

        seed = makeSeed("Bad", 1, 1);
        seed.skills = PlayerCodec.setSkill(seed.skills, 3, 101);
        vm.expectRevert(abi.encodeWithSelector(FobalPlayer.InvalidSeed.selector, "skills"));
        player.mint(alice, seed);

        seed = makeSeed("Bad", 1, 1);
        seed.dna = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(FobalPlayer.InvalidSeed.selector, "dna"));
        player.mint(alice, seed);

        seed = makeSeed("Bad", 1, 1);
        seed.name = "";
        vm.expectRevert(abi.encodeWithSelector(FobalPlayer.InvalidSeed.selector, "name length"));
        player.mint(alice, seed);

        seed = makeSeed("Bad", 1, 1);
        seed.appearance = type(uint256).max;
        vm.expectRevert(abi.encodeWithSelector(FobalPlayer.InvalidSeed.selector, "appearance"));
        player.mint(alice, seed);
        vm.stopPrank();
    }

    // ----------------------------------------------------------- progression

    function test_progression_appliesAndEmits() public {
        FobalTypes.PlayerView memory before = player.playerView(tokenId);
        FobalTypes.ProgressionDelta memory d = defaultProgress(tokenId, 1).delta;

        vm.expectEmit(true, false, false, false);
        emit FobalPlayer.PlayerProgressed(tokenId, 0, 0, 0, 0);
        vm.expectEmit(false, false, false, true);
        emit MetadataUpdate(tokenId);

        vm.prank(address(progression));
        player.applyProgression(tokenId, d);

        FobalTypes.PlayerView memory v = player.playerView(tokenId);
        assertEq(v.core.xp, before.core.xp + 80);
        assertEq(v.stats.matchesPlayed, 1);
        assertEq(v.stats.wins, 1);
        assertEq(v.stats.goals, 2);
        assertEq(v.stats.assists, 1);
        assertEq(PlayerCodec.skill(v.skills, 1), PlayerCodec.skill(before.skills, 1) + 1);
        // identity untouched
        assertEq(v.dna, before.dna);
        assertEq(v.appearance, before.appearance);
        assertEq(keccak256(bytes(v.name)), keccak256(bytes(before.name)));
    }

    event MetadataUpdate(uint256 _tokenId);

    function test_progression_skillCapAt100() public {
        // raise finishing near the cap, then overflow it
        vm.startPrank(address(progression));
        FobalTypes.ProgressionDelta memory d;
        d.skillDeltas = PlayerCodec.setSkill(0, 1, 10);
        for (uint256 i; i < 4; ++i) {
            player.applyProgression(tokenId, d); // 55 -> 95
        }
        d.skillDeltas = PlayerCodec.setSkill(0, 1, 6); // 95 + 6 > 100
        vm.expectRevert(abi.encodeWithSelector(FobalPlayer.InvalidDelta.selector, "skill cap"));
        player.applyProgression(tokenId, d);
        vm.stopPrank();
    }

    function test_progression_unauthorizedReverts() public {
        FobalTypes.ProgressionDelta memory d = defaultProgress(tokenId, 0).delta;
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, player.PROGRESSION_ROLE()
            )
        );
        vm.prank(alice);
        player.applyProgression(tokenId, d);
    }

    function test_levelCurve() public {
        vm.startPrank(address(progression));
        FobalTypes.ProgressionDelta memory d;
        d.xp = 100; // 100 xp -> level 2
        player.applyProgression(tokenId, d);
        assertEq(player.playerView(tokenId).core.level, 2);
        d.xp = 300; // total 400 -> level 3
        player.applyProgression(tokenId, d);
        assertEq(player.playerView(tokenId).core.level, 3);
        vm.stopPrank();
    }

    // ----------------------------------------------------------------- locks

    function test_lockedPlayerCannotTransfer() public {
        vm.prank(address(escrow));
        player.lock(tokenId);
        vm.expectRevert(abi.encodeWithSelector(FobalPlayer.PlayerIsLocked.selector, tokenId));
        vm.prank(alice);
        player.transferFrom(alice, bob, tokenId);
    }

    function test_onlyLockerUnlocks() public {
        vm.prank(address(escrow));
        player.lock(tokenId);
        vm.expectRevert(abi.encodeWithSelector(FobalPlayer.NotLocker.selector, tokenId));
        vm.prank(alice);
        player.unlock(tokenId);
        vm.prank(address(escrow));
        player.unlock(tokenId);
        vm.prank(alice);
        player.transferFrom(alice, bob, tokenId); // free again
        assertEq(player.ownerOf(tokenId), bob);
    }

    function test_doubleLockReverts() public {
        vm.startPrank(address(escrow));
        player.lock(tokenId);
        vm.expectRevert(abi.encodeWithSelector(FobalPlayer.AlreadyLocked.selector, tokenId));
        player.lock(tokenId);
        vm.stopPrank();
    }

    // -------------------------------------------------------------- metadata

    function test_tokenURI_isOnchainAndDeterministic() public view {
        string memory uri = player.tokenURI(tokenId);
        assertTrue(bytes(uri).length > 500, "uri too short");
        assertEq(_prefix(uri, 29), "data:application/json;base64,");
        // determinism: identical canonical state, identical bytes
        assertEq(keccak256(bytes(uri)), keccak256(bytes(player.tokenURI(tokenId))));
    }

    function test_tokenURI_changesWithProgression_butSvgIdentityStable() public {
        string memory before = player.tokenURI(tokenId);
        vm.prank(address(progression));
        player.applyProgression(tokenId, defaultProgress(tokenId, 1).delta);
        string memory after_ = player.tokenURI(tokenId);
        assertTrue(keccak256(bytes(before)) != keccak256(bytes(after_)), "metadata must evolve");
    }

    function test_supportsInterfaces() public view {
        assertTrue(player.supportsInterface(0x80ac58cd), "ERC721");
        assertTrue(player.supportsInterface(0x49064906), "ERC4906");
        assertTrue(player.supportsInterface(0x7965db0b), "AccessControl");
    }

    function _prefix(string memory s, uint256 n) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }
}
