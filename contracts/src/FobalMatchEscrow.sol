// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IFobalPlayer, FobalTypes} from "./interfaces/IFobalPlayer.sol";
import {FobalAssetRegistry} from "./FobalAssetRegistry.sol";
import {FobalProgression} from "./FobalProgression.sol";
import {FundsLedger} from "./libraries/FundsLedger.sol";

/// @title FobalMatchEscrow — stakes, player locks, and the one settlement.
/// @notice Coordinates economically consequential matches. The match itself
/// runs in the off-chain Fobal engine; this contract holds the stakes, locks
/// the committed players, verifies the engine's EIP-712 result attestation,
/// settles exactly once, and guarantees that every lock and every wei has a
/// defined release path — including when the engine never shows up.
///
/// Lifecycle:
///   OPEN --join--> LOCKED --settle(signed result)--> SETTLED
///     |               |
///     +--cancelOpen   +--cancelExpired (after resultDeadline)--> CANCELLED
///
/// The engine signer can attest results and nothing else: it holds no role,
/// cannot move funds (all payouts are pull-ledger credits), cannot touch
/// configuration, and is replaceable by SIGNER_ADMIN without migration.
contract FobalMatchEscrow is AccessControl, Pausable, EIP712, FundsLedger {
    bytes32 public constant SIGNER_ADMIN_ROLE = keccak256("SIGNER_ADMIN_ROLE");
    bytes32 public constant TREASURY_ADMIN_ROLE = keccak256("TREASURY_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 public constant MATCH_RESULT_TYPEHASH = keccak256(
        "MatchResult(bytes32 matchId,uint64 resultNonce,uint64 teamA,uint64 teamB,uint8 scoreA,uint8 scoreB,bytes32 replayHash,bytes32 statsRoot,bytes32 progressionHash,uint256 deadline)"
    );

    uint16 public constant MAX_FEE_BPS = 1_000; // hard 10% ceiling
    uint256 public constant MAX_LINEUP = 23;
    uint40 public constant MIN_RESULT_WINDOW = 10 minutes;
    uint40 public constant MAX_RESULT_WINDOW = 30 days;

    enum Mode {
        PROGRESSION,
        PRIZE
    }

    enum Status {
        NONE,
        OPEN,
        LOCKED,
        SETTLED,
        CANCELLED
    }

    struct MatchData {
        Status status;
        Mode mode;
        uint8 scoreA;
        uint8 scoreB;
        address asset;
        uint96 stake;
        address creator;
        uint64 teamA;
        address opponent; // designated (or joined) — address(0) = open challenge
        uint64 teamB;
        uint40 joinDeadline;
        uint40 resultWindow;
        uint40 resultDeadline;
        bytes32 rulesHash;
        bytes32 resultDigest; // the exact signed EIP-712 digest that settled
    }

    struct MatchResult {
        bytes32 matchId;
        uint64 resultNonce;
        uint64 teamA;
        uint64 teamB;
        uint8 scoreA;
        uint8 scoreB;
        bytes32 replayHash; // commitment to the full off-chain replay
        bytes32 statsRoot; // commitment to detailed match statistics
        bytes32 progressionHash; // keccak256(abi.encode(PlayerProgress[]))
        uint256 deadline;
    }

    IFobalPlayer public immutable player;
    FobalAssetRegistry public immutable assetRegistry;
    FobalProgression public immutable progression;

    address public engineSigner;
    address public treasury;
    uint16 public feeBps = 250; // 2.5% on PRIZE pots

    uint256 internal _matchCounter;
    mapping(bytes32 matchId => MatchData) public matches;
    mapping(bytes32 matchId => uint256[]) internal _lineupA;
    mapping(bytes32 matchId => uint256[]) internal _lineupB;

    event MatchCreated(
        bytes32 indexed matchId,
        address indexed creator,
        uint64 indexed teamA,
        Mode mode,
        address asset,
        uint96 stake,
        address opponent,
        bytes32 rulesHash
    );
    event MatchJoined(bytes32 indexed matchId, address indexed opponent, uint64 indexed teamB);
    event MatchLocked(bytes32 indexed matchId, uint40 resultDeadline);
    event MatchResultAccepted(
        bytes32 indexed matchId,
        bytes32 resultDigest,
        uint8 scoreA,
        uint8 scoreB,
        bytes32 replayHash,
        bytes32 statsRoot,
        bytes32 progressionHash
    );
    event MatchSettled(bytes32 indexed matchId, address winner, uint256 pot, uint256 fee);
    event MatchCancelled(bytes32 indexed matchId, string reason);
    event StakeDeposited(
        bytes32 indexed matchId, address indexed from, address indexed asset, uint256 amount
    );
    event StakeReleased(bytes32 indexed matchId, address indexed to, address indexed asset, uint256 amount);
    event SignerChanged(address indexed previousSigner, address indexed newSigner);
    event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury);
    event FeeChanged(uint16 previousFeeBps, uint16 newFeeBps);

    error WrongStatus(bytes32 matchId, Status actual);
    error NotParticipant(bytes32 matchId);
    error NotDesignatedOpponent(bytes32 matchId);
    error JoinDeadlinePassed(bytes32 matchId);
    error ResultDeadlineNotReached(bytes32 matchId);
    error LineupInvalid(string reason);
    error NotPlayerOwner(uint256 tokenId);
    error ResultInvalid(string reason);
    error InvalidSignature();
    error FeeTooHigh(uint16 feeBps);
    error WindowInvalid();
    error ZeroAddress();

    constructor(
        IFobalPlayer playerContract,
        FobalAssetRegistry registry,
        FobalProgression progressionModule,
        address admin,
        address signer,
        address treasuryAddress
    ) EIP712("FobalMatchEscrow", "1") {
        if (treasuryAddress == address(0)) revert ZeroAddress();
        player = playerContract;
        assetRegistry = registry;
        progression = progressionModule;
        engineSigner = signer;
        treasury = treasuryAddress;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SIGNER_ADMIN_ROLE, admin);
        _grantRole(TREASURY_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ------------------------------------------------------------- lifecycle

    function createMatch(
        Mode mode,
        address asset,
        uint96 stake,
        bytes32 rulesHash,
        address opponent,
        uint40 joinWindow,
        uint40 resultWindow,
        uint64 teamId,
        uint256[] calldata lineup
    ) external payable nonReentrant whenNotPaused returns (bytes32 matchId) {
        if (resultWindow < MIN_RESULT_WINDOW || resultWindow > MAX_RESULT_WINDOW) {
            revert WindowInvalid();
        }
        if (joinWindow == 0 || joinWindow > MAX_RESULT_WINDOW) revert WindowInvalid();
        assetRegistry.requireStakeAllowed(asset, stake);

        // effects: write the whole match record first…
        matchId = keccak256(abi.encodePacked(block.chainid, address(this), _matchCounter++));
        MatchData storage m = matches[matchId];
        m.status = Status.OPEN;
        m.mode = mode;
        m.asset = asset;
        m.stake = stake;
        m.creator = msg.sender;
        m.teamA = teamId;
        m.opponent = opponent;
        m.joinDeadline = uint40(block.timestamp) + joinWindow;
        m.resultWindow = resultWindow;
        m.rulesHash = rulesHash;
        _lineupA[matchId] = lineup;

        // …then interactions: lock the players and pull the stake
        _validateAndLockLineup(lineup);
        _pullExact(asset, msg.sender, stake);

        emit MatchCreated(matchId, msg.sender, teamId, mode, asset, stake, opponent, rulesHash);
        emit StakeDeposited(matchId, msg.sender, asset, stake);
    }

    function joinMatch(bytes32 matchId, uint64 teamId, uint256[] calldata lineup)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        MatchData storage m = matches[matchId];
        if (m.status != Status.OPEN) revert WrongStatus(matchId, m.status);
        if (block.timestamp > m.joinDeadline) revert JoinDeadlinePassed(matchId);
        if (m.opponent != address(0) && m.opponent != msg.sender) revert NotDesignatedOpponent(matchId);
        if (msg.sender == m.creator) revert NotDesignatedOpponent(matchId);

        // effects before interactions (locking + funds pull are the calls)
        m.opponent = msg.sender;
        m.teamB = teamId;
        m.status = Status.LOCKED;
        m.resultDeadline = uint40(block.timestamp) + m.resultWindow;
        _lineupB[matchId] = lineup;

        _validateAndLockLineup(lineup);
        _pullExact(m.asset, msg.sender, m.stake);

        emit StakeDeposited(matchId, msg.sender, m.asset, m.stake);
        emit MatchJoined(matchId, msg.sender, teamId);
        emit MatchLocked(matchId, m.resultDeadline);
    }

    /// @notice Creator backs out of an unjoined match. Always available —
    /// pause never traps stakes.
    function cancelOpen(bytes32 matchId) external nonReentrant {
        MatchData storage m = matches[matchId];
        if (m.status != Status.OPEN) revert WrongStatus(matchId, m.status);
        if (msg.sender != m.creator) revert NotParticipant(matchId);
        m.status = Status.CANCELLED;
        _unlockAll(_lineupA[matchId]);
        _credit(m.creator, m.asset, m.stake);
        emit StakeReleased(matchId, m.creator, m.asset, m.stake);
        emit MatchCancelled(matchId, "creator cancelled open match");
    }

    /// @notice Engine no-show path: after resultDeadline either participant
    /// unwinds the match — both stakes refunded, all players unlocked. This
    /// is the guarantee that no lock and no stake can be permanent.
    function cancelExpired(bytes32 matchId) external nonReentrant {
        MatchData storage m = matches[matchId];
        if (m.status != Status.LOCKED) revert WrongStatus(matchId, m.status);
        if (block.timestamp <= m.resultDeadline) revert ResultDeadlineNotReached(matchId);
        if (msg.sender != m.creator && msg.sender != m.opponent) revert NotParticipant(matchId);
        m.status = Status.CANCELLED;
        _unlockAll(_lineupA[matchId]);
        _unlockAll(_lineupB[matchId]);
        _credit(m.creator, m.asset, m.stake);
        _credit(m.opponent, m.asset, m.stake);
        emit StakeReleased(matchId, m.creator, m.asset, m.stake);
        emit StakeReleased(matchId, m.opponent, m.asset, m.stake);
        emit MatchCancelled(matchId, "result deadline expired");
    }

    /// @notice Settle with the engine's signed result. Exactly once per
    /// match; the submitted progression array must hash to the signed
    /// progressionHash, so one signature covers result AND progression.
    function settle(
        MatchResult calldata result,
        bytes calldata signature,
        FobalTypes.PlayerProgress[] calldata progressions
    ) external nonReentrant whenNotPaused {
        MatchData storage m = matches[result.matchId];
        if (m.status != Status.LOCKED) revert WrongStatus(result.matchId, m.status);
        if (block.timestamp > result.deadline) revert ResultInvalid("deadline");
        if (result.teamA != m.teamA || result.teamB != m.teamB) revert ResultInvalid("teams");
        if (keccak256(abi.encode(progressions)) != result.progressionHash) {
            revert ResultInvalid("progression hash");
        }

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    MATCH_RESULT_TYPEHASH,
                    result.matchId,
                    result.resultNonce,
                    result.teamA,
                    result.teamB,
                    result.scoreA,
                    result.scoreB,
                    result.replayHash,
                    result.statsRoot,
                    result.progressionHash,
                    result.deadline
                )
            )
        );
        if (!SignatureChecker.isValidSignatureNow(engineSigner, digest, signature)) {
            revert InvalidSignature();
        }

        // effects: the match is settled before any external interaction
        m.status = Status.SETTLED;
        m.scoreA = result.scoreA;
        m.scoreB = result.scoreB;
        m.resultDigest = digest;
        emit MatchResultAccepted(
            result.matchId,
            digest,
            result.scoreA,
            result.scoreB,
            result.replayHash,
            result.statsRoot,
            result.progressionHash
        );

        // funds: pull-ledger credits only — nobody's receive() can block this
        uint256 pot = uint256(m.stake) * 2;
        if (m.mode == Mode.PROGRESSION) {
            _credit(treasury, m.asset, pot);
            emit MatchSettled(result.matchId, address(0), pot, 0);
        } else {
            if (result.scoreA == result.scoreB) {
                _credit(m.creator, m.asset, m.stake);
                _credit(m.opponent, m.asset, m.stake);
                emit StakeReleased(result.matchId, m.creator, m.asset, m.stake);
                emit StakeReleased(result.matchId, m.opponent, m.asset, m.stake);
                emit MatchSettled(result.matchId, address(0), pot, 0);
            } else {
                address winner = result.scoreA > result.scoreB ? m.creator : m.opponent;
                uint256 fee = (pot * feeBps) / 10_000;
                _credit(winner, m.asset, pot - fee);
                _credit(treasury, m.asset, fee);
                emit StakeReleased(result.matchId, winner, m.asset, pot - fee);
                emit MatchSettled(result.matchId, winner, pot, fee);
            }
        }

        // progression: policy-capped module, then the player contract's own
        // invariants — the engine's discretion passes two gates
        if (progressions.length != 0) {
            progression.applyMatch(
                result.matchId, progressions, assetRegistry.progressionMultiplierBps(m.asset)
            );
        }

        _unlockAll(_lineupA[result.matchId]);
        _unlockAll(_lineupB[result.matchId]);
    }

    // ------------------------------------------------------------- internals

    function _validateAndLockLineup(uint256[] calldata lineup) internal {
        if (lineup.length == 0 || lineup.length > MAX_LINEUP) revert LineupInvalid("size");
        for (uint256 i; i < lineup.length; ++i) {
            if (player.ownerOf(lineup[i]) != msg.sender) revert NotPlayerOwner(lineup[i]);
            player.lock(lineup[i]); // reverts if already locked → no double-entry
        }
    }

    function _unlockAll(uint256[] storage lineup) internal {
        for (uint256 i; i < lineup.length; ++i) {
            player.unlock(lineup[i]);
        }
    }

    // ------------------------------------------------------------- governance

    function setSigner(address newSigner) external onlyRole(SIGNER_ADMIN_ROLE) {
        emit SignerChanged(engineSigner, newSigner);
        engineSigner = newSigner;
    }

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

    // ----------------------------------------------------------------- views

    function lineupOf(bytes32 matchId) external view returns (uint256[] memory a, uint256[] memory b) {
        return (_lineupA[matchId], _lineupB[matchId]);
    }

    function participantsOf(bytes32 matchId)
        external
        view
        returns (address creator, address opponent, Status status)
    {
        MatchData storage m = matches[matchId];
        return (m.creator, m.opponent, m.status);
    }

    /// @notice Digest helper for the off-chain engine and tests.
    function resultDigest(MatchResult calldata result) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    MATCH_RESULT_TYPEHASH,
                    result.matchId,
                    result.resultNonce,
                    result.teamA,
                    result.teamB,
                    result.scoreA,
                    result.scoreB,
                    result.replayHash,
                    result.statsRoot,
                    result.progressionHash,
                    result.deadline
                )
            )
        );
    }
}
