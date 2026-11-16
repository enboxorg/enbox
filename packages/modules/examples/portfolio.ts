import type { Enbox } from '@enbox/api';

import { defineApplicationManifest } from '@enbox/api';

import { FinancialAccountsModule } from '../src/financial-accounts.js';
import { InvestmentHoldingsModule } from '../src/investment-holdings.js';
import { StockWatchlistsModule } from '../src/stock-watchlists.js';

/** A portfolio does not need a transaction ledger installed. */
export const portfolioApplication = defineApplicationManifest({
  modules: [FinancialAccountsModule, InvestmentHoldingsModule, StockWatchlistsModule],
});

/** Example values are observations supplied by a user, not fetched market data. */
export async function createPortfolio(
  enbox: Enbox,
  asOf: string,
): Promise<{
  accountId: string;
  accountContextId: string;
  positionId: string;
  watchlistId: string;
  interestId: string;
}> {
  const account = await enbox.using(FinancialAccountsModule).records.create('account', {
    data: { name: 'Brokerage', kind: 'investment', currency: 'USD' },
  });
  const position = await enbox.using(InvestmentHoldingsModule).records.create('account/position', {
    parentContextId : account.contextId,
    data            : { instrument: { symbol: 'NVDA', exchange: 'XNAS', assetClass: 'stock' }, quantity: '10.5', asOf },
  });
  const watchlist = await enbox.using(StockWatchlistsModule).records.create('watchlist', { data: { name: 'Research' } });
  const interest = await enbox.using(StockWatchlistsModule).records.create('watchlist/instrument', {
    parentContextId : watchlist.contextId,
    data            : {
      instrument : { symbol: 'NVDA', exchange: 'XNAS', assetClass: 'stock' },
      state      : 'watching',
      reason     : 'Follow company announcements',
    },
  });
  return {
    accountId        : account.id,
    accountContextId : account.contextId!,
    positionId       : position.id,
    watchlistId      : watchlist.id,
    interestId       : interest.id,
  };
}
