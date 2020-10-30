import { waffle, ethers as deployer } from '@nomiclabs/buidler'
import { smoddit, smockit } from '@eth-optimism/smock'
import { expect } from 'chai'
import { ethers, Contract, BigNumber } from 'ethers'

async function mineBlock(provider: any, timestamp: number): Promise<void> {
  await provider.send('evm_mine', [timestamp])
}

describe('BondManager', () => {
  const provider = waffle.provider
  let wallets = provider.getWallets()

  let bondManager: Contract
  let token: Contract
  let manager: Contract
  let fraudVerifier: Contract

  const stateTransitioner = wallets[3]
  const witnessProvider = wallets[4]
  const witnessProvider2 = wallets[5]

  const sender = wallets[0].address

  const ONE_WEEK = 3600 * 24 * 7

  const preStateRoot =
    '0x1111111111111111111111111111111111111111111111111111111111111111'
  const amount = ethers.utils.parseEther('1')
  const half = amount.div(2)

  beforeEach(async () => {
    // deploy the address manager
    manager = await (
      await deployer.getContractFactory('Lib_AddressManager')
    ).deploy()

    // deploy the state manager and mock it for the state transitioner
    const stateManagerFactory = await smockit(
      await (
        await deployer.getContractFactory('OVM_StateManagerFactory')
      ).deploy()
    )
    stateManagerFactory.smocked.create.will.return.with(
      ethers.constants.AddressZero
    )
    await manager.setAddress(
      'OVM_StateManagerFactory',
      stateManagerFactory.address
    )

    // deploy the fraud verifier and mock its pre-state root transitioner
    fraudVerifier = await (
      await deployer.getContractFactory('Mock_FraudVerifier')
    ).deploy()
    await fraudVerifier.setStateTransitioner(
      preStateRoot,
      stateTransitioner.address
    )
    await manager.setAddress('OVM_FraudVerifier', fraudVerifier.address)

    // deploy a test erc20 token to be used for the bonds
    token = await (await deployer.getContractFactory('TestERC20')).deploy()
    await token.mint(sender, ethers.utils.parseEther('100'))

    bondManager = await (await smoddit('OVM_BondManager')).deploy(
      token.address,
      manager.address
    )
    await manager.setAddress('OVM_BondManager', bondManager.address)
    await fraudVerifier.setBondManager(bondManager.address)
  })

  describe('required collateral adjustment', () => {
    it('bumps required collateral', async () => {
      // sets collateral to 2 eth, which is more than what we have deposited
      await bondManager.setRequiredCollateral(ethers.utils.parseEther('2'))
      expect(await bondManager.isCollateralized(sender)).to.be.false
    })

    it('cannot lower collateral reqs', async () => {
      await expect(
        bondManager.setRequiredCollateral(ethers.utils.parseEther('0.99'))
      ).to.be.revertedWith(Errors.LOW_VALUE)
    })

    it('cannot increase collateral reqs to more than 5x of current value', async () => {
      await expect(
        bondManager.setRequiredCollateral(ethers.utils.parseEther('10.1'))
      ).to.be.revertedWith(Errors.HIGH_VALUE)
    })

    it('only owner can adjust collateral', async () => {
      await expect(
        bondManager.connect(wallets[2]).setRequiredCollateral(amount.add(1))
      ).to.be.revertedWith(Errors.ONLY_OWNER)
    })
  })

  describe('collateral management', () => {
    let balanceBefore: BigNumber

    beforeEach(async () => {
      await token.approve(bondManager.address, ethers.constants.MaxUint256)
      balanceBefore = await token.balanceOf(sender)
      await bondManager.deposit(amount)
    })

    it('can deposit', async () => {
      const balanceAfter = await token.balanceOf(sender)
      expect(balanceAfter).to.be.eq(balanceBefore.sub(amount))
      const bond = await bondManager.bonds(sender)
      expect(bond.state).to.eq(State.COLLATERALIZED)
      expect(bond.withdrawalTimestamp).to.eq(0)
    })

    it('isCollateralized is true after depositing', async () => {
      expect(await bondManager.isCollateralized(sender)).to.be.true
    })

    it('isCollateralized is false after starting a withdrawal', async () => {
      await bondManager.startWithdrawal()
      expect(await bondManager.isCollateralized(sender)).to.be.false
    })

    it('can start a withdrawal', async () => {
      await bondManager.startWithdrawal()
      const bond = await bondManager.bonds(sender)
      expect(bond.state).to.eq(State.WITHDRAWING)
      expect(bond.withdrawalTimestamp).to.not.eq(0)
    })

    it('can only withdraw after the dispute period', async () => {
      await bondManager.startWithdrawal()
      await expect(bondManager.finalizeWithdrawal()).to.be.revertedWith(
        Errors.TOO_EARLY
      )

      const { withdrawalTimestamp } = await bondManager.bonds(sender)
      const timestamp = withdrawalTimestamp + ONE_WEEK
      await mineBlock(deployer.provider, timestamp)

      const balanceBefore = await token.balanceOf(sender)
      await bondManager.finalizeWithdrawal()
      const bond = await bondManager.bonds(sender)
      expect(bond.state).to.eq(State.NOT_COLLATERALIZED)
      expect(bond.withdrawalTimestamp).to.eq(0)
      expect(await token.balanceOf(sender)).to.eq(balanceBefore.add(amount))
    })

    it('is not collateralized after withdrawing', async () => {
      await bondManager.startWithdrawal()
      const { withdrawalTimestamp } = await bondManager.bonds(sender)
      const timestamp = withdrawalTimestamp + ONE_WEEK
      await mineBlock(deployer.provider, timestamp)
      await bondManager.finalizeWithdrawal()
      expect(await bondManager.isCollateralized(sender)).to.be.false
    })
  })

  describe('dispute resolution', () => {
    const user1Gas = [382100, 500000]
    const user2Gas = 100000

    const totalUser1Gas = user1Gas[0] + user1Gas[1]
    const totalGas = totalUser1Gas + user2Gas

    beforeEach(async () => {
      await bondManager
        .connect(stateTransitioner)
        .recordGasSpent(preStateRoot, witnessProvider.address, user1Gas[0])
      await bondManager
        .connect(stateTransitioner)
        .recordGasSpent(preStateRoot, witnessProvider.address, user1Gas[1])
      await bondManager
        .connect(stateTransitioner)
        .recordGasSpent(preStateRoot, witnessProvider2.address, user2Gas)
    })

    describe('post witnesses', () => {
      it('can post witnesses from the transitioner for a state root', async () => {
        const reward = await bondManager.witnessProviders(preStateRoot)
        expect(reward.canClaim).to.be.false
        expect(reward.total).to.be.equal(totalGas)
        expect(
          await bondManager.getGasSpent(preStateRoot, witnessProvider.address)
        ).to.be.equal(totalUser1Gas)
        expect(
          await bondManager.getGasSpent(preStateRoot, witnessProvider2.address)
        ).to.be.equal(user2Gas)
      })

      it('cannot post witnesses from non-transitioners for that state root', async () => {
        await expect(
          bondManager.recordGasSpent(preStateRoot, witnessProvider.address, 100)
        ).to.be.revertedWith(Errors.ONLY_TRANSITIONER)
      })
    })

    it('cannot claim before canClaim is set', async () => {
      await expect(bondManager.claim(preStateRoot)).to.be.revertedWith(
        Errors.CANNOT_CLAIM
      )
    })

    describe('claims', () => {
      beforeEach(async () => {
        // deposit the collateral to be distributed
        await token.approve(bondManager.address, ethers.constants.MaxUint256)
        await bondManager.deposit(amount)

        // smodify the canClaim value to true to test claiming
        bondManager.smodify.set({
          witnessProviders: {
            [preStateRoot]: {
              canClaim: true,
            },
          },
        })
        const reward = await bondManager.witnessProviders(preStateRoot)
        expect(reward.canClaim).to.be.true
      })

      it('rewards get paid out proportionally', async () => {
        // One will get 2/3rds of the bond, the other will get 1/3rd
        const balanceBefore1 = await token.balanceOf(witnessProvider.address)
        const balanceBefore2 = await token.balanceOf(witnessProvider2.address)

        await bondManager.connect(witnessProvider).claim(preStateRoot)
        await bondManager.connect(witnessProvider2).claim(preStateRoot)

        const balanceAfter1 = await token.balanceOf(witnessProvider.address)
        const balanceAfter2 = await token.balanceOf(witnessProvider2.address)

        expect(balanceAfter1).to.be.eq(
          balanceBefore1.add(half.mul(totalUser1Gas).div(totalGas))
        )
        expect(balanceAfter2).to.be.eq(
          balanceBefore2.add(half.mul(user2Gas).div(totalGas))
        )
      })

      it('cannot double claim', async () => {
        const balance1 = await token.balanceOf(witnessProvider.address)
        await bondManager.connect(witnessProvider).claim(preStateRoot)
        const balance2 = await token.balanceOf(witnessProvider.address)
        expect(balance2).to.be.eq(
          balance1.add(half.mul(totalUser1Gas).div(totalGas))
        )

        // re-claiming does not give the user any extra funds
        await bondManager.connect(witnessProvider).claim(preStateRoot)
        const balance3 = await token.balanceOf(witnessProvider.address)
        expect(balance3).to.be.eq(balance2)
      })
    })

    describe('finalize', () => {
      const batchIdx = 1

      beforeEach(async () => {
        await token.approve(bondManager.address, ethers.constants.MaxUint256)
        await bondManager.deposit(amount)
      })

      it('only fraud verifier can finalize', async () => {
        await expect(
          bondManager.finalize(preStateRoot, batchIdx, sender, 0)
        ).to.be.revertedWith(Errors.ONLY_FRAUD_VERIFIER)
      })

      it('proving fraud allows claiming', async () => {
        await fraudVerifier.finalize(preStateRoot, batchIdx, sender, 0)

        expect((await bondManager.witnessProviders(preStateRoot)).canClaim).to
          .be.true

        // cannot double finalize
        await expect(
          fraudVerifier.finalize(preStateRoot, batchIdx, sender, 0)
        ).to.be.revertedWith(Errors.ALREADY_FINALIZED)
      })

      it("proving fraud cancels pending withdrawals if the withdrawal was during the batch's proving window", async () => {
        await bondManager.startWithdrawal()
        const { withdrawalTimestamp } = await bondManager.bonds(sender)
        const timestamp = withdrawalTimestamp + ONE_WEEK

        // a dispute is created about a block that intersects
        const disputeTimestamp = withdrawalTimestamp - 100
        await fraudVerifier.finalize(
          preStateRoot,
          batchIdx,
          sender,
          disputeTimestamp
        )

        await mineBlock(deployer.provider, timestamp)
        await expect(bondManager.finalizeWithdrawal()).to.be.revertedWith(
          Errors.SLASHED
        )
      })

      it('proving fraud late does not cancel pending withdrawals', async () => {
        await bondManager.startWithdrawal()
        const { withdrawalTimestamp } = await bondManager.bonds(sender)

        // a dispute is created, but since the fraud period is already over
        // it doesn't matter
        const disputeTimestamp = withdrawalTimestamp - ONE_WEEK - 1
        await fraudVerifier.finalize(
          preStateRoot,
          batchIdx,
          sender,
          disputeTimestamp
        )

        const finalizeWithdrawalTimestamp = withdrawalTimestamp + ONE_WEEK
        await mineBlock(deployer.provider, finalizeWithdrawalTimestamp)
        await bondManager.finalizeWithdrawal()
      })

      it('proving fraud prevents starting a withdrawal due to slashing', async () => {
        await fraudVerifier.finalize(preStateRoot, batchIdx, sender, 0)
        await expect(bondManager.startWithdrawal()).to.be.revertedWith(
          Errors.WRONG_STATE
        )
      })
    })
  })
})

enum State {
  // Before depositing or after getting slashed, a user is uncollateralized
  NOT_COLLATERALIZED,
  // After depositing, a user is collateralized
  COLLATERALIZED,
  // After a user has initiated a withdrawal
  WITHDRAWING,
}

// Errors from the bond manager smart contract
enum Errors {
  ERC20_ERR = 'BondManager: Could not post bond',
  LOW_VALUE = 'BondManager: New collateral value must be greater than the previous one',
  HIGH_VALUE = 'BondManager: New collateral value cannot be more than 5x of the previous one',
  ALREADY_FINALIZED = 'BondManager: Fraud proof for this pre-state root has already been finalized',
  SLASHED = 'BondManager: Cannot finalize withdrawal, you probably got slashed',
  WRONG_STATE = 'BondManager: Wrong bond state for proposer',
  CANNOT_CLAIM = 'BondManager: Cannot claim yet. Dispute must be finalized first',

  WITHDRAWAL_PENDING = 'BondManager: Withdrawal already pending',
  TOO_EARLY = 'BondManager: Too early to finalize your withdrawal',

  ONLY_OWNER = "BondManager: Only the contract's owner can call this function",
  ONLY_TRANSITIONER = 'BondManager: Only the transitioner for this pre-state root may call this function',
  ONLY_FRAUD_VERIFIER = 'BondManager: Only the fraud verifier may call this function',
  ONLY_STATE_COMMITMENT_CHAIN = 'BondManager: Only the state commitment chain may call this function',
}
