import type { Source, SourceId } from '../types';
import { secSource } from './sec';
import { asxSource } from './asx';
import { rnsSource } from './rns';
import { adyenSource } from './adyen';

export const SOURCES: Record<SourceId, Source> = {
  sec: secSource,
  asx: asxSource,
  rns: rnsSource,
  adyen: adyenSource,
};

export const SOURCE_IDS = Object.keys(SOURCES) as SourceId[];
