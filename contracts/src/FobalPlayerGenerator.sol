// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IFobalPlayer, FobalTypes} from "./interfaces/IFobalPlayer.sol";
import {PlayerCodec} from "./libraries/PlayerCodec.sol";

/// @title FobalPlayerGenerator — the only mint path into the collection.
/// @notice The off-chain generation engine signs an EIP-712 SquadMint over
/// the full player data; anyone holding a valid signed payload (normally the
/// recipient) submits it. The generator engine is AUTHORITATIVE about squad
/// composition but CONSTRAINED by protocol invariants enforced here and in
/// FobalPlayer: a compromised generator key can mint plausible footballers —
/// never gods, never infinite squads, never on other chains or contracts,
/// never twice from one signature.
contract FobalPlayerGenerator is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    using PlayerCodec for uint256;

    bytes32 public constant SIGNER_ADMIN_ROLE = keccak256("SIGNER_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 public constant SQUAD_MINT_TYPEHASH = keccak256(
        "SquadMint(address recipient,uint64 teamId,uint32 generation,uint256 nonce,uint256 deadline,bytes32 playersHash)"
    );

    uint256 public constant MAX_SQUAD_SIZE = 23;

    IFobalPlayer public immutable player;

    /// @notice EOA or ERC-1271 contract (multisig-ready) authorized to sign
    /// generation payloads. Replaceable without touching the collection.
    address public generatorSigner;

    /// @notice Max TOTAL skill points per player, averaged over the squad
    /// (total squad points <= budget * squadSize). 12 skills x 100 = 1200
    /// absolute ceiling; default 720 = a 60-average footballer.
    uint256 public perPlayerPowerBudget = 720;

    mapping(address recipient => uint256) public nonces;

    event SquadMinted(
        address indexed recipient, uint64 indexed teamId, uint256[] tokenIds, uint32 generation, uint256 nonce
    );
    event SignerChanged(address indexed previousSigner, address indexed newSigner);
    event PowerBudgetChanged(uint256 previousBudget, uint256 newBudget);

    error InvalidSignature();
    error DeadlineExpired(uint256 deadline);
    error WrongNonce(uint256 expected, uint256 given);
    error SquadSizeInvalid(uint256 size);
    error PowerBudgetExceeded(uint256 total, uint256 budget);
    error DuplicateDna(uint256 first, uint256 second);

    constructor(IFobalPlayer playerContract, address admin, address signer)
        EIP712("FobalPlayerGenerator", "1")
    {
        player = playerContract;
        generatorSigner = signer;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SIGNER_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ------------------------------------------------------------- minting

    /// @notice Mint a signed squad (1..23 players) to `recipient`.
    /// @dev playersHash binds the SIGNATURE to the full seed data: the
    /// contract recomputes it from calldata, so a signed payload cannot be
    /// replayed with different players, and any tampering breaks the hash.
    function mintSquad(
        address recipient,
        uint64 teamId,
        uint32 generation,
        uint256 deadline,
        FobalTypes.PlayerSeed[] calldata seeds,
        bytes calldata signature
    ) external whenNotPaused nonReentrant returns (uint256[] memory tokenIds) {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        if (seeds.length == 0 || seeds.length > MAX_SQUAD_SIZE) revert SquadSizeInvalid(seeds.length);

        uint256 nonce = nonces[recipient]++;
        bytes32 playersHash = keccak256(abi.encode(seeds));
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(SQUAD_MINT_TYPEHASH, recipient, teamId, generation, nonce, deadline, playersHash)
            )
        );
        if (!SignatureChecker.isValidSignatureNow(generatorSigner, digest, signature)) {
            revert InvalidSignature();
        }

        // Protocol invariant: no two players in a squad share an identity.
        // Whether teammates merely LOOK alike is a judgement about rendered
        // pixels and belongs off chain, where the dna is chosen — reproducing
        // it here would mean rendering every pair, at roughly a million gas
        // each. Identical dna is not a judgement, it is a duplicate, and a
        // squad containing one is always a bug in whatever built it. At
        // 23 players that is 253 word comparisons, which is affordable where
        // the pixel test is not.
        for (uint256 i; i < seeds.length; ++i) {
            for (uint256 j = i + 1; j < seeds.length; ++j) {
                if (seeds[i].dna == seeds[j].dna) revert DuplicateDna(i, j);
            }
        }

        // protocol invariant: total power stays inside the configured budget
        uint256 totalPoints;
        for (uint256 i; i < seeds.length; ++i) {
            totalPoints += seeds[i].skills.totalPoints();
        }
        uint256 budget = perPlayerPowerBudget * seeds.length;
        if (totalPoints > budget) revert PowerBudgetExceeded(totalPoints, budget);

        tokenIds = new uint256[](seeds.length);
        for (uint256 i; i < seeds.length; ++i) {
            // per-seed bounds (skills <= 100, valid position/name/dna) are
            // enforced by FobalPlayer.mint — the second, independent layer
            tokenIds[i] = player.mint(recipient, seeds[i]);
        }
        emit SquadMinted(recipient, teamId, tokenIds, generation, nonce);
    }

    // ------------------------------------------------------------- governance

    function setSigner(address newSigner) external onlyRole(SIGNER_ADMIN_ROLE) {
        emit SignerChanged(generatorSigner, newSigner);
        generatorSigner = newSigner;
    }

    function setPerPlayerPowerBudget(uint256 newBudget) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit PowerBudgetChanged(perPlayerPowerBudget, newBudget);
        perPlayerPowerBudget = newBudget;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // --------------------------------------------------------------- helpers

    /// @notice Digest helper for off-chain signers and tests.
    function squadMintDigest(
        address recipient,
        uint64 teamId,
        uint32 generation,
        uint256 nonce,
        uint256 deadline,
        FobalTypes.PlayerSeed[] calldata seeds
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SQUAD_MINT_TYPEHASH,
                    recipient,
                    teamId,
                    generation,
                    nonce,
                    deadline,
                    keccak256(abi.encode(seeds))
                )
            )
        );
    }
}
