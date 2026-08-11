// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IFobalPlayer} from "./interfaces/IFobalPlayer.sol";
import {FobalAssetRegistry} from "./FobalAssetRegistry.sol";
import {FundsLedger} from "./libraries/FundsLedger.sol";

/// @title FobalMarketplace — simple, atomic, honest fixed-price sales.
/// @notice Players are normal ERC-721s and can always trade externally; this
/// native market adds game-aware guarantees: a match-locked player cannot
/// sell, listings go stale the moment the seller loses ownership or
/// approval, payment is exact, and proceeds/fees ride the pull ledger so a
/// hostile receiver can never wedge a sale. Interfaces are shaped so a v2
/// can move to signed EIP-712 orders without touching FobalPlayer.
contract FobalMarketplace is AccessControl, Pausable, FundsLedger {
    bytes32 public constant TREASURY_ADMIN_ROLE = keccak256("TREASURY_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint16 public constant MAX_FEE_BPS = 1_000; // hard 10% ceiling

    struct Listing {
        address seller;
        address asset; // address(0) = ETH
        uint96 price;
        uint40 expiry;
    }

    IFobalPlayer public immutable player;
    FobalAssetRegistry public immutable assetRegistry;

    address public treasury;
    uint16 public feeBps = 250;

    mapping(uint256 tokenId => Listing) public listings;

    event PlayerListed(
        uint256 indexed tokenId, address indexed seller, address indexed asset, uint96 price, uint40 expiry
    );
    event ListingCancelled(uint256 indexed tokenId, address indexed seller);
    event PlayerSold(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        address asset,
        uint96 price,
        uint256 fee
    );
    event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury);
    event FeeChanged(uint16 previousFeeBps, uint16 newFeeBps);

    error NotOwner(uint256 tokenId);
    error PlayerLocked(uint256 tokenId);
    error NoListing(uint256 tokenId);
    error ListingExpired(uint256 tokenId);
    error ListingStale(uint256 tokenId, string reason);
    error PriceInvalid();
    error ExpiryInvalid();
    error BuyOwnListing();
    error FeeTooHigh(uint16 feeBps);
    error ZeroAddress();

    constructor(
        IFobalPlayer playerContract,
        FobalAssetRegistry registry,
        address admin,
        address treasuryAddress
    ) {
        if (treasuryAddress == address(0)) revert ZeroAddress();
        player = playerContract;
        assetRegistry = registry;
        treasury = treasuryAddress;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(TREASURY_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // -------------------------------------------------------------- listings

    function list(uint256 tokenId, address asset, uint96 price, uint40 expiry) external whenNotPaused {
        if (player.ownerOf(tokenId) != msg.sender) revert NotOwner(tokenId);
        if (player.lockedBy(tokenId) != address(0)) revert PlayerLocked(tokenId);
        if (price == 0) revert PriceInvalid();
        if (expiry <= block.timestamp) revert ExpiryInvalid();
        assetRegistry.requireEnabled(asset);
        listings[tokenId] = Listing({seller: msg.sender, asset: asset, price: price, expiry: expiry});
        emit PlayerListed(tokenId, msg.sender, asset, price, expiry);
    }

    /// @notice The listing's seller — or whoever currently owns the token
    /// (a transfer makes the old listing meaningless) — can cancel.
    function cancel(uint256 tokenId) external {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NoListing(tokenId);
        if (msg.sender != l.seller && msg.sender != player.ownerOf(tokenId)) revert NotOwner(tokenId);
        delete listings[tokenId];
        emit ListingCancelled(tokenId, l.seller);
    }

    function buy(uint256 tokenId) external payable nonReentrant whenNotPaused {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NoListing(tokenId);
        if (block.timestamp > l.expiry) revert ListingExpired(tokenId);
        if (msg.sender == l.seller) revert BuyOwnListing();
        // staleness: the chain, not the listing, is the source of truth
        if (player.ownerOf(tokenId) != l.seller) revert ListingStale(tokenId, "seller not owner");
        if (player.lockedBy(tokenId) != address(0)) revert ListingStale(tokenId, "player locked");
        assetRegistry.requireEnabled(l.asset);

        // effects before interactions
        delete listings[tokenId];
        _pullExact(l.asset, msg.sender, l.price);
        uint256 fee = (uint256(l.price) * feeBps) / 10_000;
        _credit(treasury, l.asset, fee);
        _credit(l.seller, l.asset, uint256(l.price) - fee);

        player.safeTransferFrom(l.seller, msg.sender, tokenId);
        emit PlayerSold(tokenId, l.seller, msg.sender, l.asset, l.price, fee);
    }

    // ------------------------------------------------------------- governance

    function setTreasury(address newTreasury) external onlyRole(TREASURY_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setFeeBps(uint16 newFeeBps) external onlyRole(TREASURY_ADMIN_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps);
        emit FeeChanged(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
