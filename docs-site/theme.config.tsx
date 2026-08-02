import React from 'react';
import type { DocsThemeConfig } from 'nextra-theme-docs';
import { useRouter } from 'next/router';

// Quetzal feather glyph (ported from frontend/src/components/atoms.tsx FeatherGlyph)
function FeatherGlyph({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'inline-block', flexShrink: 0 }}
    >
      <circle cx="22.5" cy="5.5" r="1.8" fill="currentColor" />
      <path
        d="M21 7 C 18 12, 14 17, 10 22 C 7 25.5, 4.5 27, 3 28"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        fill="none"
      />
      <path d="M18.5 10 L 22.5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
      <path d="M16 13 L 21 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
      <path d="M13.5 16 L 19 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
      <path d="M11 19 L 16.5 19.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
      <path d="M8.5 22 L 13.5 23" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
      <path d="M6 25 L 10.5 26.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

const APP_URL = 'https://quetzaldex.xyz';
const FAUCET_URL = 'https://faucet.quetzaldex.xyz';
const GITHUB_URL = 'https://github.com/Kubudak90/quetzal';
const DOCS_URL = 'https://docs.quetzaldex.xyz';

const config: DocsThemeConfig = {
  logo: (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <FeatherGlyph size={22} />
      <strong style={{ letterSpacing: '-0.01em' }}>Quetzal</strong>
      <span
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 11,
          color: 'var(--nextra-secondary-color, #888)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        docs
      </span>
    </span>
  ),
  project: { link: GITHUB_URL },
  docsRepositoryBase: 'https://github.com/Kubudak90/quetzal/tree/main/docs-site',
  primaryHue: { dark: 75, light: 75 }, // chartreuse-ish (~ #D4FF28 hue)
  primarySaturation: { dark: 95, light: 70 },
  banner: {
    key: 'testnet-alpha-2026',
    text: (
      <span>
        Testnet alpha · tokens have no value · audit pending ·{' '}
        <a href={APP_URL} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
          try the app →
        </a>
      </span>
    ),
  },
  navigation: { prev: true, next: true },
  darkMode: true,
  sidebar: { defaultMenuCollapseLevel: 1, toggleButton: true },
  toc: { backToTop: true },
  feedback: { content: null },
  editLink: { text: 'Edit this page on GitHub' },
  useNextSeoProps() {
    const { asPath } = useRouter();
    if (asPath === '/') {
      return {
        titleTemplate: 'Quetzal Docs',
        description: 'Trade privately. Clear together. Documentation for Quetzal — MEV-resistant dark-pool DEX on Aztec Network.',
      };
    }
    return {
      titleTemplate: '%s — Quetzal Docs',
    };
  },
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta property="og:title" content="Quetzal Docs" />
      <meta
        property="og:description"
        content="MEV-resistant dark-pool DEX on Aztec Network. Trade privately. Clear together."
      />
      <meta name="theme-color" content="#1A1400" />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    </>
  ),
  footer: {
    text: (
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          width: '100%',
          flexWrap: 'wrap',
          gap: 12,
          fontSize: 13,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <FeatherGlyph size={16} />
          <span>Quetzal · open-source, MEV-resistant, on Aztec.</span>
        </span>
        <span style={{ display: 'inline-flex', gap: 16 }}>
          <a href={APP_URL} target="_blank" rel="noopener noreferrer">App ↗</a>
          <a href={FAUCET_URL} target="_blank" rel="noopener noreferrer">Faucet ↗</a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub ↗</a>
          <a href={DOCS_URL}>Docs</a>
        </span>
      </div>
    ),
  },
};

export default config;
