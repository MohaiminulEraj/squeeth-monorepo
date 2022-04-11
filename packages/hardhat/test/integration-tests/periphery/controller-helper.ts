import { ethers } from "hardhat"
import { expect } from "chai";
import { Contract, BigNumber, providers, constants } from "ethers";
import BigNumberJs from 'bignumber.js'

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { WETH9, MockErc20, ShortPowerPerp, Controller, Oracle, WPowerPerp, ControllerHelper, INonfungiblePositionManager} from "../../../typechain";
import { deployUniswapV3, deploySqueethCoreContracts, deployWETHAndDai, addWethDaiLiquidity, addSqueethLiquidity } from '../../setup'
import { one, oracleScaleFactor, getNow } from "../../utils"
import { convertCompilerOptionsFromJson } from "typescript";

BigNumberJs.set({EXPONENTIAL_AT: 30})

describe("Controller helper integration test", function () {
  const startingEthPrice = 3000
  const startingEthPrice1e18 = BigNumber.from(startingEthPrice).mul(one) // 3000 * 1e18
  const scaledStartingSqueethPrice1e18 = startingEthPrice1e18.div(oracleScaleFactor) // 0.3 * 1e18
  const scaledStartingSqueethPrice = startingEthPrice / oracleScaleFactor.toNumber() // 0.3


  let provider: providers.JsonRpcProvider;
  let owner: SignerWithAddress;
  let depositor: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let tester: SignerWithAddress
  let dai: MockErc20
  let weth: WETH9
  let positionManager: Contract
  let uniswapFactory: Contract
  let oracle: Oracle
  let controller: Controller
  let wSqueethPool: Contract
  let wSqueeth: WPowerPerp
  let ethDaiPool: Contract
  let controllerHelper: ControllerHelper
  let shortSqueeth: ShortPowerPerp
  let swapRouter: Contract
  let quoter: Contract

  this.beforeAll("Deploy uniswap protocol & setup uniswap pool", async() => {
    const accounts = await ethers.getSigners();
    const [_owner, _depositor, _feeRecipient, _tester ] = accounts;
    owner = _owner;
    depositor = _depositor;
    feeRecipient = _feeRecipient
    tester = _tester;
    provider = ethers.provider

    const { dai: daiToken, weth: wethToken } = await deployWETHAndDai()

    dai = daiToken
    weth = wethToken

    const uniDeployments = await deployUniswapV3(weth)
    positionManager = uniDeployments.positionManager
    uniswapFactory = uniDeployments.uniswapFactory
    swapRouter = uniDeployments.swapRouter
    quoter = uniDeployments.quoter


    // this will not deploy a new pool, only reuse old onces
    const squeethDeployments = await deploySqueethCoreContracts(
      weth,
      dai, 
      positionManager, 
      uniswapFactory,
      scaledStartingSqueethPrice,
      startingEthPrice
    )
    controller = squeethDeployments.controller
    wSqueeth = squeethDeployments.wsqueeth
    oracle = squeethDeployments.oracle
    shortSqueeth = squeethDeployments.shortSqueeth
    wSqueethPool = squeethDeployments.wsqueethEthPool
    ethDaiPool = squeethDeployments.ethDaiPool
    
    const ControllerHelperUtil = await ethers.getContractFactory("ControllerHelperUtil")
    const ControllerHelperUtilLib = (await ControllerHelperUtil.deploy());
    
    const ControllerHelperContract = await ethers.getContractFactory("ControllerHelper", {libraries: {ControllerHelperUtil: ControllerHelperUtilLib.address}});
    controllerHelper = (await ControllerHelperContract.deploy(controller.address, positionManager.address, uniswapFactory.address, constants.AddressZero)) as ControllerHelper;
  })
  
  this.beforeAll("Seed pool liquidity", async() => {
    // add liquidity

    await addWethDaiLiquidity(
      startingEthPrice,
      ethers.utils.parseUnits('100'), // eth amount
      owner.address,
      dai,
      weth,
      positionManager
    )
    await provider.send("evm_increaseTime", [600])
    await provider.send("evm_mine", [])

    await addSqueethLiquidity(
      scaledStartingSqueethPrice, 
      '1000000',
      '2000000', 
      owner.address, 
      wSqueeth, 
      weth, 
      positionManager, 
      controller
    )
    await provider.send("evm_increaseTime", [600])
    await provider.send("evm_mine", [])
  })

  describe("Mint short with flash deposit", async () => {
    it("mint + sell using 100% of proceeds as collateral (with some additional ETH sent)", async () => {      
      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      // we do this just to have the the exactInputSingle static call not revert so we can estimated price impact and ethAmountOut
      await controller.connect(owner).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
      const swapParam = {
        tokenIn: wSqueeth.address,
        tokenOut: weth.address,
        fee: 3000,
        recipient: owner.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
        amountIn: mintWSqueethAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }    
      await wSqueeth.connect(owner).approve(swapRouter.address, constants.MaxUint256)
      const ethAmountOut = await swapRouter.connect(owner).callStatic.exactInputSingle(swapParam)
      const vaultId = await shortSqueeth.nextId();
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const value = collateralAmount.sub(ethAmountOut.mul(one.sub(slippage)).div(one))
      const controllerBalanceBefore = await provider.getBalance(controller.address)
      const squeethBalanceBefore = await wSqueeth.balanceOf(depositor.address)
      const vaultBefore = await controller.vaults(vaultId)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const ethToReceive = (mintWSqueethAmount.mul(squeethPrice).div(one)).mul(one.sub(slippage)).div(one)
      const params = {
        vaultId: 0,
        collateralAmount: collateralAmount.toString(),
        wPowerPerpAmountToMint: mintWSqueethAmount.toString(),
        minToReceive: ethToReceive.toString(),
        wPowerPerpAmountToSell: BigNumber.from(0)
      }

      await controllerHelper.connect(depositor).flashswapSellLongWMint(params, {value: value});

      const controllerBalanceAfter = await provider.getBalance(controller.address)
      const squeethBalanceAfter = await wSqueeth.balanceOf(depositor.address)
      const vaultAfter = await controller.vaults(vaultId)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)

      expect(controllerBalanceBefore.add(collateralAmount).eq(controllerBalanceAfter)).to.be.true
      expect(squeethBalanceBefore.eq(squeethBalanceAfter)).to.be.true
      expect(vaultBefore.collateralAmount.add(collateralAmount).eq(vaultAfter.collateralAmount)).to.be.true
      expect(vaultBefore.shortAmount.add(mintWSqueethAmount).eq(vaultAfter.shortAmount)).to.be.true
      expect(depositorEthBalanceAfter.eq(depositorEthBalanceBefore.sub(collateralAmount.sub(ethAmountOut)))).to.be.true
    })

    it("flash mint sell 100% proceeds with zero additional eth", async () => {      
      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const controllerBalanceBefore = await provider.getBalance(controller.address)
      const squeethBalanceBefore = await wSqueeth.balanceOf(depositor.address)
      const depositorBalanceInitial = await provider.getBalance(depositor.address)
      // Deposit enough collateral for 10 wSqueeth but don't mint anything
      await controller.connect(depositor).mintWPowerPerpAmount(0, 0, 0, {value: collateralAmount})
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)

      await wSqueeth.connect(depositor).approve(swapRouter.address, constants.MaxUint256)
      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address)

      await wSqueeth.connect(depositor).approve(swapRouter.address, constants.MaxUint256)
      // Get expected proceeds of sale of wSqeeth 

      const ethAmountOutFromSwap = await quoter.connect(tester).callStatic.quoteExactInputSingle(wSqueeth.address,
           weth.address,
           3000,
           mintWSqueethAmount,
           0)
      const depositorBalanceMid = await provider.getBalance(depositor.address)

      const params = {
        vaultId: vaultId.toString(),
        collateralAmount: ethAmountOutFromSwap.toString(), // deposit 100% of proceeds of swap as collateral
        wPowerPerpAmountToMint: mintWSqueethAmount.toString(),
        minToReceive: BigNumber.from(0),
        wPowerPerpAmountToSell: BigNumber.from(0)
      }
      // flash mint with zero additional eth
      await controllerHelper.connect(depositor).flashswapSellLongWMint(params);

      const controllerBalanceAfter = await provider.getBalance(controller.address)
      const squeethBalanceAfter = await wSqueeth.balanceOf(depositor.address)
      const vaultAfter = await controller.vaults(vaultId)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)
      
      // no long squeeth
      expect(squeethBalanceBefore.eq(squeethBalanceAfter)).to.be.true
      // 100% of sale proceeds added to collateral
      // console.log('test', (vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount)).div(ethAmountOutFromSwap).toString())
      // console.log('test', (vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount)).div(ethAmountOutFromSwap).eq(BigNumber.from(1)))
      expect(vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount).sub(ethAmountOutFromSwap).eq(BigNumber.from(0))).to.be.true
      // target short amount minted
      expect(vaultBefore.shortAmount.add(mintWSqueethAmount).eq(vaultAfter.shortAmount)).to.be.true
      // depositor balance reduced by collateral
      expect(depositorEthBalanceAfter.eq(depositorEthBalanceBefore)).to.be.true
    })

    it("flash mint sell, use 50% proceeds as collateral with 0 additional eth", async () => {      
      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const controllerBalanceBefore = await provider.getBalance(controller.address)
      const squeethBalanceBefore = await wSqueeth.balanceOf(depositor.address)
      // Deposit enough collateral for 10 wSqueeth but don't mint anything
      await controller.connect(depositor).mintWPowerPerpAmount(0, 0, 0, {value: collateralAmount})
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      await wSqueeth.connect(depositor).approve(swapRouter.address, constants.MaxUint256)
      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address)

      await wSqueeth.connect(owner).approve(swapRouter.address, constants.MaxUint256)

      // Get expected proceeds of sale of wSqeeth 
      const ethAmountOutFromSwap = await quoter.connect(tester).callStatic.quoteExactInputSingle(wSqueeth.address,
           weth.address,
           3000,
           mintWSqueethAmount,
           0)

      const collatToDeposit = ethAmountOutFromSwap.div(2)
      // we have to do this because of rounding
      const collatToReceive = ethAmountOutFromSwap.sub(collatToDeposit)

      const params = {
        vaultId: vaultId.toString(),
        collateralAmount: collatToDeposit.toString(), // deposit 100% of proceeds of swap as collateral
        wPowerPerpAmountToMint: mintWSqueethAmount.toString(),
        minToReceive: BigNumber.from(0),
        wPowerPerpAmountToSell: BigNumber.from(0)
      }
      // flash mint with zero additional eth
      
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)

      await controllerHelper.connect(depositor).flashswapSellLongWMint(params);

      const controllerBalanceAfter = await provider.getBalance(controller.address)
      const squeethBalanceAfter = await wSqueeth.balanceOf(depositor.address)
      const vaultAfter = await controller.vaults(vaultId)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)
      
      // no long squeeth
      expect(squeethBalanceBefore.eq(squeethBalanceAfter)).to.be.true
      // 100% of sale proceeds added to collateral
      expect(vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount).sub(ethAmountOutFromSwap.div(2)).eq(BigNumber.from(0))).to.be.true
      // target short amount minted
      expect(vaultBefore.shortAmount.add(mintWSqueethAmount).eq(vaultAfter.shortAmount)).to.be.true
      // depositor balance reduced by collateral
      
      console.log('depositorEthBalanceBefore.toString()', depositorEthBalanceBefore.toString());
      console.log('depositorEthBalanceAfter.toString()', depositorEthBalanceAfter.toString());
      const testDiff = depositorEthBalanceAfter.sub(depositorEthBalanceBefore)
      console.log('testDiff', testDiff.toString())
      console.log('expectedAmountOut', collatToReceive.toString())

      expect(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).eq(collatToReceive)).to.be.true

    })

    it("flash mint sell 0% proceeds with 0 additional eth", async () => {      
      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const controllerBalanceBefore = await provider.getBalance(controller.address)
      const squeethBalanceBefore = await wSqueeth.balanceOf(depositor.address)
      // Deposit enough collateral for 10 wSqueeth but don't mint anything
      await controller.connect(depositor).mintWPowerPerpAmount(0, 0, 0, {value: collateralAmount})
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      await wSqueeth.connect(depositor).approve(swapRouter.address, constants.MaxUint256)
      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address)

      await wSqueeth.connect(owner).approve(swapRouter.address, constants.MaxUint256)
      // Get expected proceeds of sale of wSqeeth 
      const ethAmountOutFromSwap = await quoter.connect(tester).callStatic.quoteExactInputSingle(wSqueeth.address,
           weth.address,
           3000,
           mintWSqueethAmount,
           0)

      const params = {
        vaultId: vaultId.toString(),
        collateralAmount: BigNumber.from(0), // deposit 100% of proceeds of swap as collateral
        wPowerPerpAmountToMint: mintWSqueethAmount.toString(),
        minToReceive: BigNumber.from(0),
        wPowerPerpAmountToSell: BigNumber.from(0)
      }
      // flash mint with zero additional eth
      await controllerHelper.connect(depositor).flashswapSellLongWMint(params);

      const controllerBalanceAfter = await provider.getBalance(controller.address)
      const squeethBalanceAfter = await wSqueeth.balanceOf(depositor.address)
      const vaultAfter = await controller.vaults(vaultId)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)
      
      // no long squeeth
      expect(squeethBalanceBefore.eq(squeethBalanceAfter)).to.be.true
      // 100% of sale proceeds added to collateral
      expect(vaultAfter.collateralAmount.sub(vaultBefore.collateralAmount).eq(BigNumber.from(0))).to.be.true
      // target short amount minted
      expect(vaultBefore.shortAmount.add(mintWSqueethAmount).eq(vaultAfter.shortAmount)).to.be.true
      expect(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).eq(ethAmountOutFromSwap)).to.be.true


    })
  })
  describe("Flash close short position", async () => {

    it("flash close short position and buy long", async () => {
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address)

      const vaultBefore = await controller.vaults(vaultId)
      // console.log('vaultBefore.collateralAmount', vaultBefore.collateralAmount.toString());
      // console.log('vaultBefore.shortAmount', vaultBefore.shortAmount.toString());
      const longBalanceBefore = await wSqueeth.balanceOf(depositor.address)
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      console.log(squeethPrice.toString())
      await weth.connect(owner).approve(swapRouter.address, constants.MaxUint256)

      const squeethCanBuy = await quoter.connect(tester).callStatic.quoteExactInputSingle(weth.address,
        wSqueeth.address,
        3000,
        vaultBefore.collateralAmount,
        0)

      const squeethToBuy = squeethCanBuy.sub(vaultBefore.shortAmount)

      const params = {
        vaultId,
        wPowerPerpAmountToBurn: vaultBefore.shortAmount.toString(),
        wPowerPerpAmountToBuy: squeethToBuy.toString(),
        collateralToWithdraw: vaultBefore.collateralAmount.toString(),
        maxToPay: vaultBefore.collateralAmount.toString()
      }

      await controllerHelper.connect(depositor).flashswapWBurnBuyLong(params);

      const vaultAfter = await controller.vaults(vaultId)
      const longBalanceAfter = await wSqueeth.balanceOf(depositor.address)

      expect(longBalanceBefore.toString()).eq(BigNumber.from(0))
      expect(vaultAfter.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(BigNumber.from(0))).to.be.true
      expect(longBalanceAfter.sub(longBalanceBefore).eq(squeethToBuy)).to.be.true
    })

    it("full close position returning residual ETH in vault after cost to close to user ", async () => {

      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
      const longBalanceBefore = await wSqueeth.balanceOf(depositor.address)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)

      const vaultId = (await shortSqueeth.nextId()).sub(1);
      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address)

      const vaultBefore = await controller.vaults(vaultId)
      console.log('vaultBefore.collateralAmount', vaultBefore.collateralAmount.toString());
      console.log('vaultBefore.shortAmount', vaultBefore.shortAmount.toString());
      // Get expected proceeds of sale of wSqeeth 
      const ethAmountToSwap = await quoter.connect(tester).callStatic.quoteExactOutputSingle(weth.address,
        wSqueeth.address,
        3000,
        vaultBefore.shortAmount,
        0)
       console.log('ethAmountInToSwap', ethAmountToSwap)
       console.log('maxToPay',vaultBefore.collateralAmount.sub(ethAmountToSwap).toString())
       console.log('vaultId', vaultId)
       console.log('wPowerPerpAmountToBurn', vaultBefore.shortAmount.toString())
       console.log('wPowerPerpAmountToBuy', BigNumber.from(0).toString()),
       console.log('collateralToWithdraw', vaultBefore.collateralAmount.toString())
       console.log('maxToPay', ethAmountToSwap.toString())
      const params = {
        vaultId,
        wPowerPerpAmountToBurn: vaultBefore.shortAmount.toString(),
        wPowerPerpAmountToBuy: BigNumber.from(0),
        collateralToWithdraw: vaultBefore.collateralAmount.toString(),
        maxToPay: ethAmountToSwap.toString()
      }
      // ** May be good to have some explicit revert msgs here
      await controllerHelper.connect(depositor).flashswapWBurnBuyLong(params);

      const vaultAfter = await controller.vaults(vaultId)
      const longBalanceAfter = await wSqueeth.balanceOf(depositor.address)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)

      expect(vaultAfter.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(BigNumber.from(0))).to.be.true
      expect(longBalanceAfter.eq(longBalanceBefore)).to.be.true
      expect(depositorEthBalanceBefore.sub(depositorEthBalanceAfter).eq(ethAmountToSwap))
    })

  })

  describe("Batch mint and LP", async () => {
    it("Batch mint and LP", async () => {
      const vaultId = (await shortSqueeth.nextId());

      const normFactor = await controller.getExpectedNormalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('15')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const collateralToLp = mintWSqueethAmount.mul(squeethPrice).div(one)
      const vaultBefore = await controller.vaults(vaultId)
      const tokenIndexBefore = await (positionManager as INonfungiblePositionManager).totalSupply();
      const params = {
        recipient: depositor.address,
        vaultId: 0,
        wPowerPerpAmount: mintWSqueethAmount,
        collateralToDeposit: collateralAmount,
        collateralToLp: collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        lowerTick: -887220,
        upperTick: 887220
      }

      await controllerHelper.connect(depositor).batchMintLp(params, {value: collateralAmount.add(collateralToLp)});

      const vaultAfter = await controller.vaults(vaultId)
      const tokenIndexAfter = await (positionManager as INonfungiblePositionManager).totalSupply();
      const tokenId = await (positionManager as INonfungiblePositionManager).tokenByIndex(tokenIndexAfter.sub(1));
      const ownerOfUniNFT = await (positionManager as INonfungiblePositionManager).ownerOf(tokenId); 
      const position = await (positionManager as INonfungiblePositionManager).positions(tokenId)

      expect(position.tickLower === -887220).to.be.true
      expect(position.tickUpper === 887220).to.be.true
      expect(ownerOfUniNFT === depositor.address).to.be.true
      expect(tokenIndexAfter.sub(tokenIndexBefore).eq(BigNumber.from(1))).to.be.true
      expect(vaultBefore.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultBefore.collateralAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(collateralAmount)).to.be.true
    })
  })

  describe("Sell long and flash mint short", async () => {
    before(async () => {
      let normFactor = await controller.normalizationFactor()
      let mintWSqueethAmount = ethers.utils.parseUnits('10')
      let mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      let ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      let scaledEthPrice = ethPrice.div(10000)
      let debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      let collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
      expect((await wSqueeth.balanceOf(depositor.address)).gte(mintWSqueethAmount)).to.be.true

      // minting mintWSqueethAmount to a tester address to get later how much should ETH to get for flahswap mintWSqueethAmount
      normFactor = await controller.normalizationFactor()
      mintWSqueethAmount = ethers.utils.parseUnits('150')
      mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      scaledEthPrice = ethPrice.div(10000)
      debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      await controller.connect(tester).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
      expect((await wSqueeth.balanceOf(tester.address)).gte(mintWSqueethAmount)).to.be.true
    })

    it("Sell long and flashswap mint short positon", async () => {
      const longBalance = await wSqueeth.balanceOf(depositor.address);
      console.log(longBalance.toString(), "long balance")
      const normFactor = await controller.normalizationFactor()
      const mintWSqueethAmount = ethers.utils.parseUnits('60')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const totalSqueethToSell = longBalance.add(mintWSqueethAmount)
      const swapParam = {
        tokenIn: wSqueeth.address,
        tokenOut: weth.address,
        fee: 3000,
        recipient: owner.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
        amountIn: totalSqueethToSell,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }    
 
      await wSqueeth.connect(tester).approve(swapRouter.address, constants.MaxUint256)
      const ethAmountOutFromFlashSwap = await swapRouter.connect(tester).callStatic.exactInputSingle(swapParam)

      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const value = collateralAmount.sub(ethAmountOutFromFlashSwap.mul(one.sub(slippage)).div(one))
      
      console.log(value.toString())
      
      const params = {
        vaultId: 0,
        wPowerPerpAmountToMint: mintWSqueethAmount,
        collateralAmount: collateralAmount,
        wPowerPerpAmountToSell: longBalance,
        minToReceive: BigNumber.from(0)
      }
      await wSqueeth.connect(depositor).approve(controllerHelper.address, longBalance)
      await controllerHelper.connect(depositor).flashswapSellLongWMint(params, {value: value})
      
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      // this was looking at a previous vault and was incorrect, updating the vault id here fixes it (or remove the sub(1) and keep it earlier)
      const vaultAfter = await controller.vaults(vaultId)

      expect((await wSqueeth.balanceOf(depositor.address)).eq(BigNumber.from(0))).to.be.true;
      expect(vaultAfter.shortAmount.eq(mintWSqueethAmount)).to.be.true
    })



  })

  describe("Close position with user wallet NFT: LP wPowerPerp amount is less than vault short amount", async () => {
    let tokenId: BigNumber;
    let mintWSqueethAmount : BigNumber = ethers.utils.parseUnits('10')

    before("open short and LP" , async () => {
      const normFactor = await controller.normalizationFactor()
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      // doing this way explicitly forces us to LP with less than the vault balance 
      // before it was just using the exact amount = the vault debt and probably passing because of rounding?
      // alternatively could be done like the next test where we create a new vault that we close against
      const collateralToLp = mintWSqueethAmount.mul(squeethPrice).div(one).div(2)
      const wSqueethToLp = mintWSqueethAmount.div(2)

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const token0 = isWethToken0 ? weth.address : wSqueeth.address
      const token1 = isWethToken0 ? wSqueeth.address : weth.address
  
      const mintParam = {
        token0,
        token1,
        fee: 3000,
        tickLower: -887220,// int24 min tick used when selecting full range
        tickUpper: 887220,// int24 max tick used when selecting full range
        amount0Desired: isWethToken0 ? collateralToLp : wSqueethToLp,
        amount1Desired: isWethToken0 ? wSqueethToLp : collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        recipient: depositor.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),// uint256
      }
  
      await weth.connect(depositor).deposit({value: collateralToLp})
      await weth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)
      await wSqueeth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)  
      const tx = await (positionManager as INonfungiblePositionManager).connect(depositor).mint(mintParam)
      const receipt = await tx.wait();
      tokenId = (receipt.events?.find(event => event.event === 'IncreaseLiquidity'))?.args?.tokenId;  
    })

    it("Close position with NFT from user", async () => {
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const amount0Min = BigNumber.from(0);
      const amount1Min = BigNumber.from(0);

      const positionBefore = await (positionManager as INonfungiblePositionManager).positions(tokenId);

      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(positionManager.address, tokenId); 
      const [amount0, amount1] = await (positionManager as INonfungiblePositionManager).connect(depositor).callStatic.decreaseLiquidity({
        tokenId: tokenId,
        liquidity: positionBefore.liquidity,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
      })
      const wPowerPerpAmountInLP = (isWethToken0) ? amount1 : amount0;
      const wethAmountInLP = (isWethToken0) ? amount0 : amount1;
      const liquidityPercentage = BigNumber.from(1).mul(BigNumber.from(10).pow(18))

      const wPowerPerpAmountToWithdraw = wPowerPerpAmountInLP.mul(liquidityPercentage).div(one)
      const wethAmountToWithdraw = wethAmountInLP.mul(liquidityPercentage).div(one)

      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const limitPriceEthPerPowerPerp = squeethPrice.mul(one.add(slippage)).div(one);

      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address);
      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(controllerHelper.address, tokenId); 
      await controllerHelper.connect(depositor).closeShortWithUserNft({
        vaultId, 
        tokenId,
        liquidity: positionBefore.liquidity,
        liquidityPercentage: liquidityPercentage,
        wPowerPerpAmountToBurn: mintWSqueethAmount, 
        collateralToWithdraw: vaultBefore.collateralAmount, 
        limitPriceEthPerPowerPerp,
        amount0Min: BigNumber.from(0), 
        amount1Min:BigNumber.from(0)
      })

      const positionAfter = await (positionManager as INonfungiblePositionManager).positions(tokenId);
      const vaultAfter = await controller.vaults(vaultId);
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)

      expect(positionAfter.liquidity.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(BigNumber.from(0))).to.be.true

      if(wPowerPerpAmountToWithdraw.lt(mintWSqueethAmount)) {
        const ethToBuySqueeth = (mintWSqueethAmount.sub(wPowerPerpAmountToWithdraw)).mul(squeethPrice).div(one); 
        const remainingETHFromLp = wethAmountToWithdraw.sub(ethToBuySqueeth);
        //might be good to check actual slippage here instead of <= 0.01, which is kinda arbitrary, but i tried doing it and its hard because need to simulate two transactions remove liquidity + swap
        // can do by simulating the swap before adding liquidity as I do later, but haven't implemented it for now
        expect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(remainingETHFromLp)).div(one).toString()) <= 0.01).to.be.true
      }
      else if (wPowerPerpAmountToWithdraw.gt(mintWSqueethAmount)) {
        const wPowerPerpAmountToSell = wPowerPerpAmountToWithdraw.sub(mintWSqueethAmount);
        const ethToGet = wPowerPerpAmountToSell.mul(squeethPrice).div(one);

        expect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(ethToGet).add(wethAmountToWithdraw)).div(one).toString()) <= 0.01).to.be.true
      }
    })
  })

  describe("Close second position with user wallet NFT from 1st short: (remove 100% liquidity) LP wPowerPerp amount is more than vault short amount", async () => {
    let tokenId: BigNumber;
    let mintWSqueethAmount: BigNumber;

    before("open first short position and LP" , async () => {
      const normFactor = await controller.normalizationFactor()
      const mintWSqueethAmountToLp : BigNumber = ethers.utils.parseUnits('20')
      const mintRSqueethAmount = mintWSqueethAmountToLp.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const collateralToLp = mintWSqueethAmountToLp.mul(squeethPrice).div(one)

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmountToLp, 0, {value: collateralAmount})

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const token0 = isWethToken0 ? weth.address : wSqueeth.address
      const token1 = isWethToken0 ? wSqueeth.address : weth.address

      const mintParam = {
        token0,
        token1,
        fee: 3000,
        tickLower: -887220,// int24 min tick used when selecting full range
        tickUpper: 887220,// int24 max tick used when selecting full range
        amount0Desired: isWethToken0 ? collateralToLp : mintWSqueethAmountToLp,
        amount1Desired: isWethToken0 ? mintWSqueethAmountToLp : collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        recipient: depositor.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),// uint256
      }

      await weth.connect(depositor).deposit({value: collateralToLp})
      await weth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)
      await wSqueeth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)  
      const tx = await (positionManager as INonfungiblePositionManager).connect(depositor).mint(mintParam)
      const receipt = await tx.wait();
      tokenId = (receipt.events?.find(event => event.event === 'IncreaseLiquidity'))?.args?.tokenId;  
    })

    before("open short amount less than amount in LP position" , async () => {
      const normFactor = await controller.normalizationFactor()
      mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
    })

    it("Close position with NFT from user", async () => {
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const amount0Min = BigNumber.from(0);
      const amount1Min = BigNumber.from(0);
      const positionBefore = await (positionManager as INonfungiblePositionManager).positions(tokenId);

      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(positionManager.address, tokenId); 
      const [amount0, amount1] = await (positionManager as INonfungiblePositionManager).connect(depositor).callStatic.decreaseLiquidity({
        tokenId: tokenId,
        liquidity: positionBefore.liquidity,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
      })
      const wPowerPerpAmountInLP = (isWethToken0) ? amount1 : amount0;
      const wethAmountInLP = (isWethToken0) ? amount0 : amount1;
      const liquidityPercentage = BigNumber.from(1).mul(BigNumber.from(10).pow(18))

      const wPowerPerpAmountToWithdraw = wPowerPerpAmountInLP.mul(liquidityPercentage).div(one)
      const wethAmountToWithdraw = wethAmountInLP.mul(liquidityPercentage).div(one)
      
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const limitPriceEthPerPowerPerp = squeethPrice.mul(one.sub(slippage)).div(one);

      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address);
      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(controllerHelper.address, tokenId); 
      await controllerHelper.connect(depositor).closeShortWithUserNft({
        vaultId, 
        tokenId,
        liquidity: positionBefore.liquidity,
        liquidityPercentage: liquidityPercentage,
        wPowerPerpAmountToBurn: mintWSqueethAmount, 
        collateralToWithdraw: vaultBefore.collateralAmount, 
        limitPriceEthPerPowerPerp, 
        amount0Min: BigNumber.from(0), 
        amount1Min:BigNumber.from(0)
      })

      const positionAfter = await (positionManager as INonfungiblePositionManager).positions(tokenId);
      const vaultAfter = await controller.vaults(vaultId);
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)

      expect(positionAfter.liquidity.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(BigNumber.from(0))).to.be.true

      if(wPowerPerpAmountToWithdraw.lt(mintWSqueethAmount)) {
        const ethToBuySqueeth = (mintWSqueethAmount.sub(wPowerPerpAmountToWithdraw)).mul(squeethPrice).div(one); 
        const remainingETHFromLp = wethAmountToWithdraw.sub(ethToBuySqueeth);

        expect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(remainingETHFromLp)).div(one).toString()) <= 0.01).to.be.true
      }
      else if (wPowerPerpAmountToWithdraw.gt(mintWSqueethAmount)) {
        const wPowerPerpAmountToSell = wPowerPerpAmountToWithdraw.sub(mintWSqueethAmount);
        const ethToGet = wPowerPerpAmountToSell.mul(squeethPrice).div(one);

        expect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(ethToGet).add(wethAmountToWithdraw)).div(one).toString()) <= 0.01).to.be.true
      }

    })
  })

  describe("Close second position with user wallet NFT from 1st short: (remove 60% liquidity) LP wPowerPerp amount is more than vault short amount", async () => {
    let tokenId: BigNumber;
    let mintWSqueethAmount: BigNumber;

    before("open first short position and LP" , async () => {
      const normFactor = await controller.normalizationFactor()
      const mintWSqueethAmountToLp : BigNumber = ethers.utils.parseUnits('20')
      const mintRSqueethAmount = mintWSqueethAmountToLp.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const collateralToLp = mintWSqueethAmountToLp.mul(squeethPrice).div(one)

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmountToLp, 0, {value: collateralAmount})

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const token0 = isWethToken0 ? weth.address : wSqueeth.address
      const token1 = isWethToken0 ? wSqueeth.address : weth.address

      const mintParam = {
        token0,
        token1,
        fee: 3000,
        tickLower: -887220,// int24 min tick used when selecting full range
        tickUpper: 887220,// int24 max tick used when selecting full range
        amount0Desired: isWethToken0 ? collateralToLp : mintWSqueethAmountToLp,
        amount1Desired: isWethToken0 ? mintWSqueethAmountToLp : collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        recipient: depositor.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),// uint256
      }

      await weth.connect(depositor).deposit({value: collateralToLp})
      await weth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)
      await wSqueeth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)  
      const tx = await (positionManager as INonfungiblePositionManager).connect(depositor).mint(mintParam)
      const receipt = await tx.wait();
      tokenId = (receipt.events?.find(event => event.event === 'IncreaseLiquidity'))?.args?.tokenId;  
    })

    before("open short amount less than amount in LP position" , async () => {
      const normFactor = await controller.normalizationFactor()
      mintWSqueethAmount = ethers.utils.parseUnits('10')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})
    })

    it("Close position with NFT from user", async () => {
      const vaultId = (await shortSqueeth.nextId()).sub(1);
      const vaultBefore = await controller.vaults(vaultId)
      const amount0Min = BigNumber.from(0);
      const amount1Min = BigNumber.from(0);
      const liquidityPercentage = BigNumber.from(6).mul(BigNumber.from(10).pow(17))
      const positionBefore = await (positionManager as INonfungiblePositionManager).positions(tokenId);

      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(positionManager.address, tokenId); 
      const [amount0, amount1] = await (positionManager as INonfungiblePositionManager).connect(depositor).callStatic.decreaseLiquidity({
        tokenId: tokenId,
        liquidity: positionBefore.liquidity,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
      })

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 

      const wPowerPerpAmountInLP = (isWethToken0) ? amount1 : amount0;
      const wethAmountInLP = (isWethToken0) ? amount0 : amount1;

      const wPowerPerpAmountToWithdraw = wPowerPerpAmountInLP.mul(liquidityPercentage).div(one)
      const wethAmountToWithdraw = wethAmountInLP.mul(liquidityPercentage).div(one)
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const limitPriceEthPerPowerPerp = squeethPrice.mul(one.sub(slippage)).div(one);

      await controller.connect(depositor).updateOperator(vaultId, controllerHelper.address);
      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(controllerHelper.address, tokenId); 
      
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      await controllerHelper.connect(depositor).closeShortWithUserNft({
        vaultId, 
        tokenId,
        liquidity: positionBefore.liquidity,
        liquidityPercentage: liquidityPercentage,
        wPowerPerpAmountToBurn: mintWSqueethAmount, 
        collateralToWithdraw: vaultBefore.collateralAmount, 
        limitPriceEthPerPowerPerp, 
        amount0Min: BigNumber.from(0), 
        amount1Min:BigNumber.from(0)
      })

      const positionAfter = await (positionManager as INonfungiblePositionManager).positions(tokenId);
      const vaultAfter = await controller.vaults(vaultId);
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)

      expect(positionAfter.liquidity.sub(positionBefore.liquidity.div(2)).lte(1)).to.be.true
      expect(vaultAfter.shortAmount.eq(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.eq(BigNumber.from(0))).to.be.true
      
      if(wPowerPerpAmountToWithdraw.lt(mintWSqueethAmount)) {
        const ethToBuySqueeth = (mintWSqueethAmount.sub(wPowerPerpAmountToWithdraw)).mul(squeethPrice).div(one); 
        const remainingETHFromLp = wethAmountToWithdraw.sub(ethToBuySqueeth);

        expect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(remainingETHFromLp)).div(one).toString()) <= 0.01).to.be.true
      }
      else if (wPowerPerpAmountToWithdraw.gt(mintWSqueethAmount)) {
        const wPowerPerpAmountToSell = wPowerPerpAmountToWithdraw.sub(mintWSqueethAmount);
        const ethToGet = wPowerPerpAmountToSell.mul(squeethPrice).div(one);

        expect(Number(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(vaultBefore.collateralAmount.add(ethToGet).add(wethAmountToWithdraw)).div(one).toString()) <= 0.01).to.be.true
      }

    })
  })

  describe("Withdraw to ETH", async () => {
    let collateralToLp: BigNumber;
    let mintWSqueethAmount: BigNumber;
    let ethAmountOut: BigNumber;

    before("open position and LP", async () => {
      const normFactor = await controller.normalizationFactor()
      mintWSqueethAmount = ethers.utils.parseUnits('35')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 1, true)
      // we do this to ensure we use the maximum wSqueethAmount for LPing, which makes the expect statements easier
      collateralToLp = mintWSqueethAmount.mul(squeethPrice).div(one).mul(2)

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const token0 = isWethToken0 ? weth.address : wSqueeth.address
      const token1 = isWethToken0 ? wSqueeth.address : weth.address
  
      await controller.connect(owner).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})

      const swapParam = {
        tokenIn: wSqueeth.address,
        tokenOut: weth.address,
        fee: 3000,
        recipient: owner.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
        amountIn: mintWSqueethAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }    
      await wSqueeth.connect(owner).approve(swapRouter.address, constants.MaxUint256)
      ethAmountOut = await swapRouter.connect(owner).callStatic.exactInputSingle(swapParam)
      console.log(mintWSqueethAmount.toString(), "squeeth expected in lp")
      console.log(collateralToLp.toString(), "weth expected  in lp")

      const mintParam = {
        token0,
        token1,
        fee: 3000,
        tickLower: -887220,// int24 min tick used when selecting full range
        tickUpper: 887220,// int24 max tick used when selecting full range
        amount0Desired: isWethToken0 ? collateralToLp : mintWSqueethAmount,
        amount1Desired: isWethToken0 ? mintWSqueethAmount : collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        recipient: depositor.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),// uint256
      }
  
      await weth.connect(depositor).deposit({value: collateralToLp})
      await weth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)
      await wSqueeth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)  
      await (positionManager as INonfungiblePositionManager).connect(depositor).mint(mintParam)
    })

    it("sell all to ETH", async () => {
      const tokenIndexAfter = await (positionManager as INonfungiblePositionManager).totalSupply();
      const tokenId = await (positionManager as INonfungiblePositionManager).tokenByIndex(tokenIndexAfter.sub(1));
      const positionBefore = await (positionManager as INonfungiblePositionManager).positions(tokenId);

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const amount0Min = BigNumber.from(0);
      const amount1Min = BigNumber.from(0);

      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(positionManager.address, tokenId); 
      const [amount0, amount1] = await (positionManager as INonfungiblePositionManager).connect(depositor).callStatic.decreaseLiquidity({
        tokenId: tokenId,
        liquidity: positionBefore.liquidity,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
      })
      const wPowerPerpAmountInLP = (isWethToken0) ? amount1 : amount0;
      const wethAmountInLP = (isWethToken0) ? amount0 : amount1;

      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const limitPriceEthPerPowerPerp = squeethPrice.mul(one.sub(slippage)).div(one);
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      const params = {
        tokenId: tokenId,
        liquidity: positionBefore.liquidity,
        amount0Min: 0,
        amount1Min: 0,
        limitPriceEthPerPowerPerp: limitPriceEthPerPowerPerp
      }

      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(controllerHelper.address, tokenId);
      await controllerHelper.connect(depositor).sellAll(params);

      const depositorEthBalanceAfter= await provider.getBalance(depositor.address)

      console.log(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).toString())
      console.log(wethAmountInLP.add(ethAmountOut).toString())

      // 1 wei difference due to uniswap rounding
      expect(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).sub(wethAmountInLP.add(ethAmountOut)).abs().lte(1)).to.be.true
    })
  })

  describe("Rebalance LP through trading amounts", async () => {
    let collateralToLp: BigNumber;
    let mintWSqueethAmount: BigNumber;
    let squeethAmountOut: BigNumber;

    before("open position and LP", async () => {
      const normFactor = await controller.normalizationFactor()
      mintWSqueethAmount = ethers.utils.parseUnits('35')
      const mintRSqueethAmount = mintWSqueethAmount.mul(normFactor).div(one)
      const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 420, true)
      const scaledEthPrice = ethPrice.div(10000)
      const debtInEth = mintRSqueethAmount.mul(scaledEthPrice).div(one)
      const collateralAmount = debtInEth.mul(3).div(2).add(ethers.utils.parseUnits('0.01'))
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 1, true)
      // we want to LP with all of the ETH collateral which can be guaranteed by using less vs what is expected
      collateralToLp = mintWSqueethAmount.mul(squeethPrice).div(one).mul(4).div(5)

      await controller.connect(depositor).mintWPowerPerpAmount(0, mintWSqueethAmount, 0, {value: collateralAmount})

      await weth.connect(owner).deposit({value: collateralToLp})

      const swapParam = {
        tokenIn: weth.address,
        tokenOut: wSqueeth.address,
        fee: 3000,
        recipient: owner.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
        amountIn: collateralToLp,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }    
      await weth.connect(owner).approve(swapRouter.address, constants.MaxUint256)
      squeethAmountOut = await swapRouter.connect(owner).callStatic.exactInputSingle(swapParam)
      console.log(mintWSqueethAmount.toString(), "squeeth expected in lp")
      console.log(collateralToLp.toString(), "weth expected  in lp")


      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const token0 = isWethToken0 ? weth.address : wSqueeth.address
      const token1 = isWethToken0 ? wSqueeth.address : weth.address
  
      const mintParam = {
        token0,
        token1,
        fee: 3000,
        tickLower: -887220,// int24 min tick used when selecting full range
        tickUpper: 887220,// int24 max tick used when selecting full range
        amount0Desired: isWethToken0 ? collateralToLp : mintWSqueethAmount,
        amount1Desired: isWethToken0 ? mintWSqueethAmount : collateralToLp,
        amount0Min: 0,
        amount1Min: 0,
        recipient: depositor.address,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),// uint256
      }
  
      await weth.connect(depositor).deposit({value: collateralToLp})
      await weth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)
      await wSqueeth.connect(depositor).approve(positionManager.address, ethers.constants.MaxUint256)  
      await (positionManager as INonfungiblePositionManager).connect(depositor).mint(mintParam)
    })

    it("rebalance to decrease WETH amount and LP only oSQTH", async () => {
      let tokenIndexAfter = await (positionManager as INonfungiblePositionManager).totalSupply();
      const oldTokenId = await (positionManager as INonfungiblePositionManager).tokenByIndex(tokenIndexAfter.sub(1));
      const oldPosition = await (positionManager as INonfungiblePositionManager).positions(oldTokenId);
      const squeethPrice = await oracle.getTwap(wSqueethPool.address, wSqueeth.address, weth.address, 420, true)
      const slippage = BigNumber.from(3).mul(BigNumber.from(10).pow(16))
      const limitPriceEthPerPowerPerp = squeethPrice.mul(one.add(slippage)).div(one);

      const slot0 = await wSqueethPool.slot0()
      const currentTick = slot0[1]

      console.log(currentTick.toString())
      const lowerTick = 60*((currentTick - currentTick%60)/60 + 1)
      console.log(lowerTick.toString(), "lower tick")


      console.log("made it here!")

      const tokenId = await (positionManager as INonfungiblePositionManager).tokenByIndex(tokenIndexAfter.sub(1));
      const positionBefore = await (positionManager as INonfungiblePositionManager).positions(tokenId);

      const isWethToken0 : boolean = parseInt(weth.address, 16) < parseInt(wSqueeth.address, 16) 
      const amount0Min = BigNumber.from(0);
      const amount1Min = BigNumber.from(0);


      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(positionManager.address, tokenId); 
      const [amount0, amount1] = await (positionManager as INonfungiblePositionManager).connect(depositor).callStatic.decreaseLiquidity({
        tokenId: tokenId,
        liquidity: positionBefore.liquidity,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
      })
      const wPowerPerpAmountInLP = (isWethToken0) ? amount1 : amount0;
      const wethAmountInLP = (isWethToken0) ? amount0 : amount1;
      //uniswap LPing often will give 1 wei less than expected, with the price of oSQTH need to do more than 1 wei due to rounding up the amount owed 
      const squeethDesired = wPowerPerpAmountInLP.sub(4).add(squeethAmountOut)

      const params = {
        tokenId: oldTokenId,
        ethAmountToLp: BigNumber.from(0),
        liquidity: oldPosition.liquidity,
        wPowerPerpAmountDesired: squeethDesired,
        wethAmountDesired: ethers.utils.parseUnits('1'),
        amount0DesiredMin: BigNumber.from(0),
        amount1DesiredMin: BigNumber.from(0),
        limitPriceEthPerPowerPerp,
        amount0Min: BigNumber.from(0),
        amount1Min: BigNumber.from(0),
        lowerTick: lowerTick,
        upperTick: 887220
        //rebalanceToken0: false,
        //rebalanceToken1: false
      }

      await (positionManager as INonfungiblePositionManager).connect(depositor).approve(controllerHelper.address, oldTokenId);
      await controllerHelper.connect(depositor).rebalanceWithoutVault(params);

      tokenIndexAfter = await (positionManager as INonfungiblePositionManager).totalSupply();
      const newTokenId = await (positionManager as INonfungiblePositionManager).tokenByIndex(tokenIndexAfter.sub(1));
      const newPosition = await (positionManager as INonfungiblePositionManager).positions(newTokenId);
      const ownerOfUniNFT = await (positionManager as INonfungiblePositionManager).ownerOf(newTokenId); 

      const [amount0New, amount1New] = await (positionManager as INonfungiblePositionManager).connect(depositor).callStatic.decreaseLiquidity({
        tokenId: newTokenId,
        liquidity: newPosition.liquidity,
        amount0Min: BigNumber.from(0),
        amount1Min: BigNumber.from(0),
        deadline: Math.floor(await getNow(ethers.provider) + 8640000),
      })

      console.log("amount0", amount0New.toString())
      console.log("amount1", amount1New.toString())

      const wPowerPerpAmountInNewLp = (isWethToken0) ? amount1New : amount0New;
      const wethAmountInNewLp = (isWethToken0) ? amount0New : amount1New;


      expect(ownerOfUniNFT === depositor.address).to.be.true;
      console.log(wPowerPerpAmountInNewLp.toString(), squeethDesired.toString())
      expect(wPowerPerpAmountInNewLp.sub(squeethDesired).lte(4)).to.be.true
      expect(wethAmountInNewLp.eq(BigNumber.from(0))).to.be.true
    })
  })
})