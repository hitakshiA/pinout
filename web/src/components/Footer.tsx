"use client";

import Image from "next/image";
import { motion } from "motion/react";
import Mark from "./Mark";

/**
 * Layered-card footer with a background-blended wordmark.
 *
 * The reference for this is a light theme: a grey shell holding a white panel.
 * Inverting it literally on a near-black page gives you a grey slab that reads
 * as a mistake, so the relationship is what carries over rather than the
 * values. The shell sits barely above the page, the panel lifts again above
 * the shell, and the separation comes from a hairline rather than contrast.
 */

const COLUMNS = [
  {
    title: "Compute",
    links: [
      { label: "Machines", href: "#lanes" },
      { label: "Pricing", href: "#lanes" },
      { label: "How it works", href: "#how" },
    ],
  },
  {
    title: "Build",
    links: [
      { label: "Source", href: "https://github.com/hitakshiA/pinout" },
      { label: "Agent tools", href: "https://github.com/hitakshiA/pinout#for-ai-agents" },
      { label: "Verifier", href: "https://github.com/hitakshiA/pinout#verification" },
    ],
  },
  {
    title: "Network",
    links: [
      { label: "Hedera", href: "https://hedera.com" },
      { label: "x402", href: "https://x402.org" },
      { label: "HashScan", href: "https://hashscan.io/testnet" },
    ],
  },
];

/**
 * The same mark as the header, one size up.
 *
 * The footer had its own drawing and its own capitalisation, so the page
 * introduced itself twice under two slightly different names. `.mark` is the
 * header's; scaling it here keeps one lockup across the page.
 */
function LogoMark() {
  return <Mark size={30} />;
}

/**
 * The wordmark. The filter is doing all the work: a drop shadow underneath,
 * then an inner white edge and an inner black edge built by blurring the
 * source alpha and compositing it back out of itself. That is what makes flat
 * white type read as something with a thickness to it.
 */
function GlassText() {
  return (
    <div className="fglass">
      <svg className="fglass-defs" aria-hidden="true" focusable="false">
        <defs>
          <filter id="pinout-glass" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="4" stdDeviation="10" floodColor="#06040d"
                          floodOpacity="0.55" result="outer-shadow" />
            <feComponentTransfer in="SourceAlpha" result="alpha">
              <feFuncA type="linear" slope="1" />
            </feComponentTransfer>
            <feOffset in="alpha" dx="0" dy="4" result="offset-white" />
            <feGaussianBlur in="offset-white" stdDeviation="4" result="blur-white" />
            <feComposite in="alpha" in2="blur-white" operator="out" result="inner-white-mask" />
            <feFlood floodColor="#bbb6fd" floodOpacity="0.30" result="white-fill" />
            <feComposite in="white-fill" in2="inner-white-mask" operator="in"
                         result="inner-white-final" />
            <feGaussianBlur in="alpha" stdDeviation="6" result="blur-black" />
            <feComposite in="alpha" in2="blur-black" operator="out" result="inner-black-mask" />
            <feFlood floodColor="#06040d" floodOpacity="0.35" result="black-fill" />
            <feComposite in="black-fill" in2="inner-black-mask" operator="in"
                         result="inner-black-final" />
            <feMerge>
              <feMergeNode in="outer-shadow" />
              <feMergeNode in="SourceGraphic" />
              <feMergeNode in="inner-white-final" />
              <feMergeNode in="inner-black-final" />
            </feMerge>
          </filter>
        </defs>
      </svg>

      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 1.8, ease: [0.16, 1, 0.3, 1] }}
        className="fglass-in"
      >
        <h2 className="fglass-word" style={{ filter: "url(#pinout-glass)" }}>Pinout</h2>
      </motion.div>
    </div>
  );
}

export default function Footer() {
  return (
    <footer className="foot2">
      <div className="wrap">
        <div className="fshell">
          <div className="fpanel">
            <div className="fgrid">
              <div className="fbrand">
                <div className="fbrand-top">
                  <LogoMark />
                  <span className="fwordmark">Pinout</span>
                </div>
                <p className="fdesc">
                  Metered payments and settlement for agents. One payment opens a pool of
                  credits, a meter burns it, and the remainder is refunded on Hedera.
                </p>
                <div className="fbadges">
                  <Image src="/brand/hedera.webp" alt="Hedera" width={107} height={30} />
                  <Image className="logo-x402" src="/brand/x402.svg" alt="x402"
                         width={80} height={31} />
                </div>
              </div>

              {COLUMNS.map((col) => (
                <div className="fcol" key={col.title}>
                  <h4>{col.title}</h4>
                  <ul>
                    {col.links.map((l) => (
                      <li key={l.label}><a href={l.href}>{l.label}</a></li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className="flegal">
            <p>Pinout &middot; Hedera testnet &middot; MIT</p>
            <div className="flegal-r">
              <a href="https://github.com/hitakshiA/pinout">GitHub</a>
              <span className="fsep" />
              <a href="https://github.com/hitakshiA/pinout/blob/main/LICENSE">License</a>
            </div>
          </div>
        </div>
      </div>

      <GlassText />
    </footer>
  );
}
