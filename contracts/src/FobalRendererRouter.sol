// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IFobalRenderer} from "./interfaces/IFobalRenderer.sol";

/// @title FobalRendererRouter — the safety valve in front of the art.
/// @notice `FobalPlayer.renderer` is the protocol's only mutable
/// cross-contract pointer, `FobalPlayer.tokenURI` has NO try/catch, and
/// `setRenderer(address(0))` reverts — so there is no off switch. Pointing
/// that lever straight at a fresh art renderer means one unlucky seed can
/// take metadata down for the whole collection, with recovery gated on
/// whoever holds DEFAULT_ADMIN.
///
/// This contract is installed ONCE as a byte-identical no-op (default and
/// fallback both pointing at the renderer already live), after which every
/// art change is a storage write here instead of a coin flip on that
/// pointer — revertible per token, per cohort, or wholesale.
///
/// THREE GUARANTEES:
///  1. `tokenURI` is TOTAL. A renderer that reverts, returns malformed data,
///     or burns all the gas it is given falls through to the fallback
///     renderer, and then to an inline identity card. It cannot revert.
///  2. Gas is RESERVED, not hoped for. try/catch cannot catch out-of-gas, so
///     each attempt is given `gasleft() - FALLBACK_RESERVE`; the reserve is
///     what pays for the fallback path.
///  3. ZERO ART, FOREVER. This contract holds no palettes, parts or layout.
///     Its only drawing is the last-resort card, which needs nothing but the
///     token id and so cannot itself fail.
contract FobalRendererRouter is IFobalRenderer, AccessControl {
    using Strings for uint256;

    /// @notice routing changes; held by a TimelockController in production
    bytes32 public constant ROUTER_ADMIN_ROLE = keccak256("ROUTER_ADMIN_ROLE");

    /// @dev enough to run the fallback renderer and, failing that, the card
    uint256 private constant FALLBACK_RESERVE = 250_000;
    /// @dev tokenURI is a view every marketplace calls; keep the scan bounded
    uint256 public constant MAX_COHORTS = 16;

    struct Cohort {
        uint256 fromId;
        uint256 toId;
        address renderer;
    }

    address public defaultRenderer;
    address public fallbackRenderer;
    Cohort[] private _cohorts;
    /// @notice single-token override — the canary lane
    mapping(uint256 tokenId => address) public pinnedRenderer;

    event DefaultRendererChanged(address indexed previous, address indexed next);
    event FallbackRendererChanged(address indexed previous, address indexed next);
    event CohortSet(uint256 indexed index, uint256 fromId, uint256 toId, address indexed renderer);
    event CohortsCleared(uint256 count);
    event TokenPinned(uint256 indexed tokenId, address indexed renderer);

    error ZeroAddress();
    error TooManyCohorts();
    error BadRange();

    constructor(address admin, address initialRenderer) {
        if (admin == address(0) || initialRenderer == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ROUTER_ADMIN_ROLE, admin);
        // installed as a no-op: both lanes point at the renderer already live
        defaultRenderer = initialRenderer;
        fallbackRenderer = initialRenderer;
    }

    // ------------------------------------------------------------ rendering

    function version() external pure returns (string memory) {
        return "router-v1";
    }

    /// @notice Resolution order: pin -> newest matching cohort -> default.
    /// Exposed so operators can prove what a token WILL use before promoting.
    function rendererFor(uint256 tokenId) public view returns (address) {
        address pinned = pinnedRenderer[tokenId];
        if (pinned != address(0)) return pinned;
        for (uint256 i = _cohorts.length; i > 0; --i) {
            Cohort storage c = _cohorts[i - 1];
            if (tokenId >= c.fromId && tokenId <= c.toId) return c.renderer;
        }
        return defaultRenderer;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        address chosen = rendererFor(tokenId);
        (bool ok, string memory uri) = _attempt(chosen, tokenId);
        if (ok) return uri;

        address alt = fallbackRenderer;
        if (alt != chosen) {
            (ok, uri) = _attempt(alt, tokenId);
            if (ok) return uri;
        }
        // Nothing rendered. Return a card rather than reverting: a broken
        // image is recoverable, a reverting tokenURI is a collection-wide
        // outage that marketplaces cache as permanent failure.
        return _identityCard(tokenId);
    }

    /// @dev The attempt is made through an external self-call so that a
    /// malformed return value fails in the INNER frame (where abi.decode
    /// reverting is caught) and so that the gas cap actually binds.
    function _attempt(address renderer, uint256 tokenId) private view returns (bool, string memory) {
        if (renderer == address(0)) return (false, "");
        uint256 available = gasleft();
        if (available <= FALLBACK_RESERVE) return (false, "");
        try this.renderThrough{gas: available - FALLBACK_RESERVE}(renderer, tokenId) returns (string memory uri) {
            if (bytes(uri).length == 0) return (false, "");
            return (true, uri);
        } catch {
            return (false, "");
        }
    }

    /// @dev External only so it can be try/caught; callable by anyone as a
    /// plain passthrough (it reads no router state and grants nothing).
    function renderThrough(address renderer, uint256 tokenId) external view returns (string memory) {
        return IFobalRenderer(renderer).tokenURI(tokenId);
    }

    /// @dev The floor. Depends on nothing but the token id, so it cannot fail.
    function _identityCard(uint256 tokenId) private pure returns (string memory) {
        string memory id = tokenId.toString();
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">',
            '<rect width="32" height="32" fill="#101826"/>',
            '<rect x="6" y="9" width="20" height="14" fill="#1b2942"/>',
            '<rect x="6" y="9" width="20" height="2" fill="#22c55e"/>',
            '<text x="16" y="19" font-family="monospace" font-size="6" fill="#f8fafc" text-anchor="middle">#',
            id,
            "</text></svg>"
        );
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(
                bytes(
                    string.concat(
                        '{"name":"FOBAL Player #',
                        id,
                        '","description":"Metadata is temporarily unavailable for this player. Ownership, attributes and match history are unaffected and held on-chain.","image":"data:image/svg+xml;base64,',
                        Base64.encode(bytes(svg)),
                        '"}'
                    )
                )
            )
        );
    }

    // --------------------------------------------------------------- admin

    function setDefaultRenderer(address next) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (next == address(0)) revert ZeroAddress();
        emit DefaultRendererChanged(defaultRenderer, next);
        defaultRenderer = next;
    }

    function setFallbackRenderer(address next) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (next == address(0)) revert ZeroAddress();
        emit FallbackRendererChanged(fallbackRenderer, next);
        fallbackRenderer = next;
    }

    function setCohort(uint256 fromId, uint256 toId, address renderer) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (renderer == address(0)) revert ZeroAddress();
        if (fromId == 0 || toId < fromId) revert BadRange();
        if (_cohorts.length >= MAX_COHORTS) revert TooManyCohorts();
        _cohorts.push(Cohort({fromId: fromId, toId: toId, renderer: renderer}));
        emit CohortSet(_cohorts.length - 1, fromId, toId, renderer);
    }

    function clearCohorts() external onlyRole(ROUTER_ADMIN_ROLE) {
        uint256 n = _cohorts.length;
        delete _cohorts;
        emit CohortsCleared(n);
    }

    function pin(uint256 tokenId, address renderer) external onlyRole(ROUTER_ADMIN_ROLE) {
        pinnedRenderer[tokenId] = renderer; // address(0) unpins
        emit TokenPinned(tokenId, renderer);
    }

    function cohortCount() external view returns (uint256) {
        return _cohorts.length;
    }

    function cohortAt(uint256 i) external view returns (Cohort memory) {
        return _cohorts[i];
    }
}
