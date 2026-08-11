// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalMatchEscrow} from "../../src/FobalMatchEscrow.sol";
import {FobalMarketplace} from "../../src/FobalMarketplace.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";

/// @notice The engine/generator signers hold NO roles: they can sign game
/// facts and nothing else. These tests prove the negative — the powerful keys
/// cannot seize NFTs, move treasury funds, change fees/config, or self-promote.
contract AccessControlTest is BaseFixture {
    function test_engineSignerHoldsNoRoles() public view {
        assertFalse(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), engineSigner));
        assertFalse(escrow.hasRole(escrow.TREASURY_ADMIN_ROLE(), engineSigner));
        assertFalse(player.hasRole(player.PROGRESSION_ROLE(), engineSigner));
        assertFalse(player.hasRole(player.LOCK_ROLE(), engineSigner));
    }

    function test_engineCannotWithdrawTreasury() public {
        // engine has no ledger credit and no admin power
        vm.prank(engineSigner);
        vm.expectRevert();
        escrow.withdraw(address(0)); // NothingToWithdraw
        vm.prank(engineSigner);
        vm.expectRevert();
        escrow.setTreasury(engineSigner);
    }

    function test_engineCannotSeizePlayers() public {
        uint256[] memory ids = mintSquadFor(alice, 0, 1);
        vm.prank(engineSigner);
        vm.expectRevert(); // not owner, not approved
        player.transferFrom(alice, engineSigner, ids[0]);
        vm.prank(engineSigner);
        vm.expectRevert(); // no PROGRESSION_ROLE
        player.applyProgression(ids[0], defaultProgress(ids[0], 0).delta);
    }

    function test_generatorCannotBecomeAdmin() public {
        bytes32 adminRole = player.DEFAULT_ADMIN_ROLE();
        vm.prank(address(generator));
        vm.expectRevert();
        player.grantRole(adminRole, address(generator));
    }

    function test_treasuryAdminCannotChangeSkills() public {
        uint256[] memory ids = mintSquadFor(alice, 0, 1);
        // TREASURY_ADMIN on escrow has no PROGRESSION_ROLE on player
        vm.prank(admin); // admin holds treasury admin but role is on wrong contract
        vm.expectRevert();
        player.applyProgression(ids[0], defaultProgress(ids[0], 0).delta);
    }

    function test_pauserCannotStealFunds() public {
        address pauser = makeAddr("pauser");
        bytes32 pauserRole = escrow.PAUSER_ROLE();
        vm.prank(admin);
        escrow.grantRole(pauserRole, pauser);
        vm.prank(pauser);
        vm.expectRevert();
        escrow.setTreasury(pauser);
        vm.prank(pauser);
        vm.expectRevert();
        escrow.setFeeBps(0);
    }

    function test_onlyTreasuryAdminSetsFees() public {
        vm.prank(alice);
        vm.expectRevert();
        market.setFeeBps(100);
        vm.prank(admin);
        market.setFeeBps(100);
        assertEq(market.feeBps(), 100);
    }

    function test_onlySignerAdminRotatesSigner() public {
        vm.prank(alice);
        vm.expectRevert();
        escrow.setSigner(alice);
        vm.prank(admin);
        escrow.setSigner(makeAddr("newEngine"));
        assertEq(escrow.engineSigner(), makeAddr("newEngine"));
    }

    function test_roleSeparation_signerAdminIsNotTreasuryAdmin() public {
        address signerAdmin = makeAddr("signerAdmin");
        bytes32 signerAdminRole = escrow.SIGNER_ADMIN_ROLE();
        vm.prank(admin);
        escrow.grantRole(signerAdminRole, signerAdmin);
        // can rotate the signer...
        vm.prank(signerAdmin);
        escrow.setSigner(makeAddr("e2"));
        // ...but cannot touch the treasury
        vm.prank(signerAdmin);
        vm.expectRevert();
        escrow.setTreasury(signerAdmin);
    }
}
