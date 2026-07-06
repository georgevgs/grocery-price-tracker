import type { RetailerId } from '@grocery/core/types';
import { abAdapter } from './ab';
import { galaxiasAdapter } from './galaxias';
import { kritikosAdapter } from './kritikos';
import { lidlAdapter } from './lidl';
import { masoutisAdapter } from './masoutis';
import { mymarketAdapter } from './mymarket';
import { sklavenitisAdapter } from './sklavenitis';
import type { RetailerAdapter } from './types';

export const adapterRegistry = new Map<RetailerId, RetailerAdapter>([
  [sklavenitisAdapter.id, sklavenitisAdapter],
  [abAdapter.id, abAdapter],
  [lidlAdapter.id, lidlAdapter],
  [masoutisAdapter.id, masoutisAdapter],
  [mymarketAdapter.id, mymarketAdapter],
  [kritikosAdapter.id, kritikosAdapter],
  [galaxiasAdapter.id, galaxiasAdapter],
]);
