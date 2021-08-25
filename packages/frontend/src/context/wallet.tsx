import BigNumber from 'bignumber.js'
import Onboard from 'bnc-onboard'
import { API } from 'bnc-onboard/dist/src/interfaces'
import { ethers } from 'ethers'
import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import Web3 from 'web3'

import { Networks } from '../types'

type WalletType = {
  web3: Web3 | null
  address: string | null
  networkId: Networks
  signer: any
  selectWallet: () => void
  connected: boolean
  balance: BigNumber
}

const initialState: WalletType = {
  web3: null,
  address: null,
  networkId: Networks.MAINNET,
  signer: null,
  selectWallet: () => null,
  connected: false,
  balance: new BigNumber(0),
}

const walletContext = React.createContext<WalletType>(initialState)
const useWallet = () => useContext(walletContext)

const WalletProvider: React.FC = ({ children }) => {
  const [web3, setWeb3] = useState<Web3 | null>(null)
  const [address, setAddress] = useState('')
  const [networkId, setNetworkId] = useState(0)
  const [onboard, setOnboard] = useState<API | null>(null)
  const [signer, setSigner] = useState<any>(null)
  const [balance, setBalance] = useState<BigNumber>(new BigNumber(0))

  const onWalletSelect = useCallback(async () => {
    if (!onboard) return
    onboard.walletSelect().then((success) => {
      if (success) onboard.walletCheck()
    })
  }, [onboard])

  const store: WalletType = useMemo(
    () => ({
      web3,
      address,
      networkId,
      signer,
      connected: !!address,
      balance,
      selectWallet: onWalletSelect,
    }),
    [web3, address, networkId, signer, balance, onWalletSelect],
  )

  useEffect(() => {
    const onNetworkChange = (updateNetwork: number) => {
      if (updateNetwork in Networks) {
        setNetworkId(updateNetwork)
        if (onboard !== null) {
          const network = updateNetwork === 1337 ? 31337 : updateNetwork
          localStorage.setItem('networkId', network.toString())
          onboard.config({
            networkId: network,
          })
        }
      }
    }

    const onWalletUpdate = (wallet: any) => {
      if (wallet.provider) {
        window.localStorage.setItem('selectedWallet', wallet.name)
        const provider = new ethers.providers.Web3Provider(wallet.provider)
        setWeb3(new Web3(wallet.provider))
        setSigner(() => provider.getSigner())
      }
    }

    const _network = networkId !== 0 ? networkId : parseInt(localStorage.getItem('networkId') || '1')
    const network = networkId === 1 ? 'mainnet' : networkId === 42 ? 'kovan' : 'ropsten'
    const RPC_URL =
      networkId === Networks.LOCAL
        ? 'http://127.0.0.1:8545/'
        : `https://${network}.infura.io/v3/${process.env.NEXT_PUBLIC_INFURA_API_KEY}`

    const onboard = Onboard({
      dappId: process.env.NEXT_PUBLIC_BLOCKNATIVE_DAPP_ID,
      networkId: _network,
      darkMode: true,
      subscriptions: {
        address: setAddress,
        network: onNetworkChange,
        wallet: onWalletUpdate,
        balance: (balance) => setBalance(new BigNumber(balance)),
      },
      walletSelect: {
        wallets: [
          { walletName: 'metamask', preferred: true },
          {
            walletName: 'walletConnect',
            preferred: true,
            infuraKey: process.env.NEXT_PUBLIC_INFURA_API_KEY,
          },
          {
            walletName: 'lattice',
            rpcUrl: RPC_URL,
            preferred: true,
            appName: 'Opyn V2',
          },
          { walletName: 'coinbase', preferred: true },
          {
            walletName: 'ledger',
            preferred: true,
            rpcUrl: RPC_URL,
          },
        ],
      },
    })

    setOnboard(onboard)

    const previouslySelectedWallet = window.localStorage.getItem('selectedWallet')

    if (previouslySelectedWallet && onboard) {
      onboard.walletSelect(previouslySelectedWallet).then((success) => {
        console.log('Connected to wallet', success)
      })
    }
  }, [networkId])

  return <walletContext.Provider value={store}>{children}</walletContext.Provider>
}

export { useWallet, WalletProvider }