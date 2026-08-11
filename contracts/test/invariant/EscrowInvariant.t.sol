// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BaseFixture} from "../BaseFixture.sol";
import {FobalMatchEscrow} from "../../src/FobalMatchEscrow.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";

/// @notice Drives the escrow through random create/join/settle/cancel cycles
/// and tracks how much ETH it should be holding. The invariant: the escrow's
/// ETH balance always equals the stakes still locked in live matches plus the
/// credits nobody has withdrawn yet — value is never created or destroyed.
contract EscrowHandler is Test {
    FobalMatchEscrow public escrow;
    BaseFixtureExposed public fx;

    address[] internal actors;
    bytes32[] internal openMatches;
    bytes32[] internal lockedMatches;

    uint256 public ghost_liveStakes; // ETH in OPEN or LOCKED matches
    uint256 public ghost_credited; // ETH credited but not withdrawn

    uint96 constant STAKE = 1 ether;

    constructor(BaseFixtureExposed fixture) {
        fx = fixture;
        escrow = fixture.escrowContract();
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            vm.deal(a, 1000 ether);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function createMatch(uint256 seed) public {
        address a = _actor(seed);
        uint256[] memory lineup = fx.mintOne(a);
        vm.prank(a);
        try escrow.createMatch{value: STAKE}(
            FobalMatchEscrow.Mode.PRIZE,
            address(0),
            STAKE,
            keccak256("r"),
            address(0),
            1 days,
            1 days,
            1,
            lineup
        ) returns (
            bytes32 matchId
        ) {
            openMatches.push(matchId);
            ghost_liveStakes += STAKE;
        } catch {}
    }

    function joinMatch(uint256 seed) public {
        if (openMatches.length == 0) return;
        bytes32 matchId = openMatches[seed % openMatches.length];
        address a = _actor(seed >> 8);
        uint256[] memory lineup = fx.mintOne(a);
        vm.prank(a);
        try escrow.joinMatch{value: STAKE}(matchId, 2, lineup) {
            ghost_liveStakes += STAKE;
            _removeOpen(matchId);
            lockedMatches.push(matchId);
        } catch {}
    }

    function settleMatch(uint256 seed) public {
        if (lockedMatches.length == 0) return;
        bytes32 matchId = lockedMatches[seed % lockedMatches.length];
        (address creator, address opponent,) = escrow.participantsOf(matchId);
        if (creator == address(0) || opponent == address(0)) return;

        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = FobalMatchEscrow.MatchResult({
            matchId: matchId,
            resultNonce: 1,
            teamA: 1,
            teamB: 2,
            scoreA: uint8(seed % 4),
            scoreB: uint8((seed >> 4) % 4),
            replayHash: keccak256("r"),
            statsRoot: keccak256("s"),
            progressionHash: keccak256(abi.encode(progs)),
            deadline: block.timestamp + 1 hours
        });
        try escrow.settle(result, fx.sign(result), progs) {
            ghost_liveStakes -= STAKE * 2;
            ghost_credited += STAKE * 2; // pot always fully credited somewhere
            _removeLocked(matchId);
        } catch {}
    }

    function cancelExpired(uint256 seed) public {
        if (lockedMatches.length == 0) return;
        bytes32 matchId = lockedMatches[seed % lockedMatches.length];
        (address creator,,) = escrow.participantsOf(matchId);
        vm.warp(block.timestamp + 2 days);
        vm.prank(creator);
        try escrow.cancelExpired(matchId) {
            ghost_liveStakes -= STAKE * 2;
            ghost_credited += STAKE * 2;
            _removeLocked(matchId);
        } catch {}
    }

    function withdraw(uint256 seed) public {
        address a = _actor(seed);
        uint256 bal = escrow.withdrawable(a, address(0));
        vm.prank(a);
        try escrow.withdraw(address(0)) {
            ghost_credited -= bal;
        } catch {}
    }

    function _removeOpen(bytes32 matchId) internal {
        for (uint256 i; i < openMatches.length; ++i) {
            if (openMatches[i] == matchId) {
                openMatches[i] = openMatches[openMatches.length - 1];
                openMatches.pop();
                return;
            }
        }
    }

    function _removeLocked(bytes32 matchId) internal {
        for (uint256 i; i < lockedMatches.length; ++i) {
            if (lockedMatches[i] == matchId) {
                lockedMatches[i] = lockedMatches[lockedMatches.length - 1];
                lockedMatches.pop();
                return;
            }
        }
    }
}

/// @dev Exposes fixture internals (minting, signing) to the handler.
contract BaseFixtureExposed is BaseFixture {
    function escrowContract() external view returns (FobalMatchEscrow) {
        return escrow;
    }

    function mintOne(address to) external returns (uint256[] memory) {
        return mintSquadFor(to, 1, 1);
    }

    function sign(FobalMatchEscrow.MatchResult memory result) external view returns (bytes memory) {
        return signResult(result);
    }
}

contract EscrowInvariantTest is Test {
    BaseFixtureExposed internal fx;
    EscrowHandler internal handler;

    function setUp() public {
        fx = new BaseFixtureExposed();
        fx.setUp();
        handler = new EscrowHandler(fx);
        targetContract(address(handler));
    }

    /// @notice The core conservation law: the escrow holds exactly the live
    /// stakes plus the un-withdrawn credits — not a wei more or less.
    function invariant_balanceEqualsLiveStakesPlusCredits() public view {
        assertEq(address(handler.escrow()).balance, handler.ghost_liveStakes() + handler.ghost_credited());
    }
}
