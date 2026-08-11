// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalMarketplace} from "../../src/FobalMarketplace.sol";
import {FobalMatchEscrow} from "../../src/FobalMatchEscrow.sol";
import {FobalAssetRegistry} from "../../src/FobalAssetRegistry.sol";
import {FundsLedger} from "../../src/libraries/FundsLedger.sol";
import {MockSairi} from "../../src/mocks/MockSairi.sol";

contract MarketplaceTest is BaseFixture {
    uint256 internal tokenId;

    function setUp() public override {
        super.setUp();
        uint256[] memory ids = mintSquadFor(alice, 0, 1);
        tokenId = ids[0];
        vm.prank(alice);
        player.setApprovalForAll(address(market), true);
    }

    function _list(uint96 price) internal {
        vm.prank(alice);
        market.list(tokenId, address(0), price, uint40(block.timestamp + 1 days));
    }

    function test_buy_eth_atomic() public {
        _list(1 ether);
        vm.prank(bob);
        market.buy{value: 1 ether}(tokenId);

        assertEq(player.ownerOf(tokenId), bob, "NFT moved exactly once");
        uint256 fee = (1 ether * 250) / 10_000;
        assertEq(market.withdrawable(alice, address(0)), 1 ether - fee, "seller proceeds");
        assertEq(market.withdrawable(treasury, address(0)), fee, "fee exact");
        assertEq(address(market).balance, 1 ether, "escrowed until withdrawal");

        uint256 before = alice.balance;
        vm.prank(alice);
        market.withdraw(address(0));
        assertEq(alice.balance, before + 1 ether - fee);
    }

    function test_buy_exactPaymentRequired() public {
        _list(1 ether);
        vm.startPrank(bob);
        vm.expectRevert(FundsLedger.UnexpectedEthValue.selector);
        market.buy{value: 0.5 ether}(tokenId);
        vm.expectRevert(FundsLedger.UnexpectedEthValue.selector);
        market.buy{value: 1.5 ether}(tokenId);
        vm.stopPrank();
    }

    function test_sellerMustOwn_listingGoesStale() public {
        _list(1 ether);
        vm.prank(alice);
        player.transferFrom(alice, makeAddr("charlie"), tokenId);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(FobalMarketplace.ListingStale.selector, tokenId, "seller not owner")
        );
        market.buy{value: 1 ether}(tokenId);
    }

    function test_lockedPlayerCannotListOrSell() public {
        // lock via a real match commitment
        uint256[] memory lineup = new uint256[](1);
        lineup[0] = tokenId;
        vm.prank(alice);
        escrow.createMatch{value: 1 ether}(
            FobalMatchEscrow_ModeProgression(),
            address(0),
            1 ether,
            keccak256("r"),
            address(0),
            1 days,
            1 days,
            1,
            lineup
        );
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FobalMarketplace.PlayerLocked.selector, tokenId));
        market.list(tokenId, address(0), 1 ether, uint40(block.timestamp + 1 days));
    }

    function test_listThenLock_buyGoesStale() public {
        _list(1 ether);
        uint256[] memory lineup = new uint256[](1);
        lineup[0] = tokenId;
        vm.prank(alice);
        escrow.createMatch{value: 1 ether}(
            FobalMatchEscrow_ModeProgression(),
            address(0),
            1 ether,
            keccak256("r"),
            address(0),
            1 days,
            1 days,
            1,
            lineup
        );
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(FobalMarketplace.ListingStale.selector, tokenId, "player locked")
        );
        market.buy{value: 1 ether}(tokenId);
    }

    function test_expiredListingFails() public {
        _list(1 ether);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(FobalMarketplace.ListingExpired.selector, tokenId));
        market.buy{value: 1 ether}(tokenId);
    }

    function test_cancelledListingCannotExecute() public {
        _list(1 ether);
        vm.prank(alice);
        market.cancel(tokenId);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(FobalMarketplace.NoListing.selector, tokenId));
        market.buy{value: 1 ether}(tokenId);
    }

    function test_erc20_purchase() public {
        MockSairi sairi = new MockSairi();
        vm.prank(admin);
        assets.setAsset(
            address(sairi),
            FobalAssetRegistry.AssetConfig({
                enabled: true, minStake: 1, maxStake: type(uint96).max, progressionMultiplierBps: 10_000
            })
        );
        sairi.mint(bob, 1_000e18);
        vm.prank(bob);
        sairi.approve(address(market), type(uint256).max);

        vm.prank(alice);
        market.list(tokenId, address(sairi), 500e18, uint40(block.timestamp + 1 days));
        vm.prank(bob);
        market.buy(tokenId);

        assertEq(player.ownerOf(tokenId), bob);
        uint256 fee = (500e18 * 250) / 10_000;
        assertEq(market.withdrawable(alice, address(sairi)), 500e18 - fee);
        assertEq(market.withdrawable(treasury, address(sairi)), fee);
    }

    function test_unsupportedAssetFails() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FobalAssetRegistry.AssetDisabled.selector, address(0xDEAD)));
        market.list(tokenId, address(0xDEAD), 1 ether, uint40(block.timestamp + 1 days));
    }

    function test_feeHardCap() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FobalMarketplace.FeeTooHigh.selector, 1_001));
        market.setFeeBps(1_001);
    }

    function test_progressedPlayerSurvivesSale() public {
        vm.prank(address(progression));
        player.applyProgression(tokenId, defaultProgress(tokenId, 1).delta);
        bytes32 dnaBefore = player.dnaOf(tokenId);
        string memory uriBefore = player.tokenURI(tokenId);

        _list(1 ether);
        vm.prank(bob);
        market.buy{value: 1 ether}(tokenId);

        // ownership changed; identity, evolution and career did not
        assertEq(player.ownerOf(tokenId), bob);
        assertEq(player.dnaOf(tokenId), dnaBefore);
        assertEq(player.playerView(tokenId).stats.goals, 2);
        assertEq(player.playerView(tokenId).core.xp, 80);
        // tokenURI differs ONLY through the owner-independent state: it is
        // identical because the renderer reads no owner-dependent fields
        assertEq(keccak256(bytes(player.tokenURI(tokenId))), keccak256(bytes(uriBefore)));
    }

    function FobalMatchEscrow_ModeProgression() internal pure returns (FobalMatchEscrow.Mode) {
        return FobalMatchEscrow.Mode.PROGRESSION;
    }
}
