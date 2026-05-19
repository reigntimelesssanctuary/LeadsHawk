import type { LhApi } from '../../preload/index';

declare global {
  interface Window {
    lh: LhApi;
  }
}
export {};
