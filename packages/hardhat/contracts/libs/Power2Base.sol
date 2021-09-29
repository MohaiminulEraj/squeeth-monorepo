// SPDX-License-Identifier: MIT

pragma solidity =0.7.6;

import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {OracleLibrary} from "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {IOracle} from "../interfaces/IOracle.sol";

library Power2Base {
    using SafeMath for uint256;

    /**
     * @dev return the index of the power perp in DAI, scaled by 18 decimals
     * @return for squeeth, return ethPrice^2
     */
    function _getIndex(
        uint32 _period,
        address _oracle,
        address _ethDaiPool,
        address _weth,
        address _dai
    ) internal view returns (uint256) {
        uint256 ethDaiPrice = _getTwap(_oracle, _ethDaiPool, _weth, _dai, _period);
        return ethDaiPrice.mul(ethDaiPrice).div(1e18);
    }

    /**
     * @dev return the mark price of power perp in DAI, scaled by 18 decimals
     * @return for squeeth, return ethPrice * squeethPriceInEth
     */
    function _getDenormalizedMark(
        uint32 _period,
        address _oracle,
        address _squeethEthPool,
        address _ethDaiPool,
        address _weth,
        address _dai,
        address _wsqueeth,
        uint256 _normalizationFactor
    ) internal view returns (uint256) {
        uint256 ethDaiPrice = _getTwap(_oracle, _ethDaiPool, _weth, _dai, _period);
        uint256 squeethEthPrice = _getTwap(_oracle, _squeethEthPool, address(_wsqueeth), _weth, _period);

        return squeethEthPrice.mul(ethDaiPrice).div(_normalizationFactor);
    }

    /**
     * @dev get fair collateral amount to pay out to a liquidator repaying _debtAmount debt
     * @dev the actual amount liquidator can get should have a x% bonus on top of this value.
     * @param _debtAmount wSqueeth amount paid by liquidator
     * @return
     */
    function _getCollateralByRepayAmount(
        uint256 _debtAmount,
        address _oracle,
        address _ethDaiPool,
        address _weth,
        address _dai,
        uint256 _normalizationFactor
    ) internal view returns (uint256) {
        uint256 ethDaiPrice = IOracle(_oracle).getTwapSafe(_ethDaiPool, _weth, _dai, 600);
        return _debtAmount.mul(_normalizationFactor).mul(ethDaiPrice).div(1e36);
    }

    /**
     * @dev request twap from our oracle.
     * @return price scaled by 1e18
     */
    function _getTwap(
        address _oracle,
        address _pool,
        address _base,
        address _quote,
        uint32 _period
    ) internal view returns (uint256) {
        // period reaching this point should be check, otherwise might revert
        uint256 twap = IOracle(_oracle).getTwap(_pool, _base, _quote, _period);
        require(twap != 0, "WAP WAP WAP");

        return twap;
    }

    /**
     * @notice get the index value of wsqueeth in wei, used when system settles
     * @dev the index of squeeth is ethPrice^2, so each squeeth will need to pay out {ethPrice} eth
     * @param _wsqueethAmount amount of wsqueeth used in settlement
     * @param _ethSettlementPrice eth price used for settlement. scaled with 1e18
     * @return amount in wei that should be paid to the token holder
     */
    function _getLongSettlementValue(
        uint256 _wsqueethAmount,
        uint256 _ethSettlementPrice,
        uint256 _normalizationFactor
    ) internal pure returns (uint256) {
        return _wsqueethAmount.mul(_normalizationFactor).mul(_ethSettlementPrice).div(1e36);
    }
}
