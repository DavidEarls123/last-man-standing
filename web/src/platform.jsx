import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { BRAND } from './lib/brand.js';

const PlatformContext = createContext(null);

const FALLBACK = { company: BRAND.company, mark: 'horseshoe', isDefault: true };

/**
 * Who the platform is calling itself right now.
 *
 * Normally Off The Bridle Sports. The super admin can point it at a club for a
 * trial, so every place the company is named reads this rather than a constant.
 * Fetched once at boot from a public endpoint, because the sign-in screen needs
 * it before anybody has signed in.
 */
export function PlatformProvider({ children }) {
  const [branding, setBranding] = useState(FALLBACK);

  const load = useCallback(async () => {
    try {
      const { branding: live } = await api.get('/api/platform');
      setBranding(live);
      return live;
    } catch {
      // A platform that cannot say its own name still has to let people in.
      setBranding(FALLBACK);
      return FALLBACK;
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The tab and the bookmark should match whoever is running it.
  useEffect(() => {
    document.title = branding.isDefault
      ? BRAND.product
      : `${BRAND.product} · ${branding.company}`;
  }, [branding]);

  const value = useMemo(() => ({ ...branding, reload: load }), [branding, load]);
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export const usePlatform = () => useContext(PlatformContext) ?? FALLBACK;
