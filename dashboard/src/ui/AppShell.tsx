import { useCallback, useRef, useState } from 'react';

/** Deep space + gold aurora orbs + subtle grid (fixed, non-interactive). */
export function AppBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-[#030208]" />
      <div
        className="absolute -top-[40%] -left-[10%] h-[85%] w-[70%] rounded-full opacity-70 motion-safe:animate-[aurora_22s_ease-in-out_infinite]"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(212, 175, 55, 0.14) 0%, rgba(180, 83, 9, 0.05) 40%, transparent 65%)',
        }}
      />
      <div
        className="absolute -bottom-[35%] -right-[15%] h-[75%] w-[60%] rounded-full opacity-60 motion-safe:animate-[aurora2_26s_ease-in-out_infinite]"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(251, 191, 36, 0.1) 0%, rgba(120, 53, 15, 0.06) 45%, transparent 68%)',
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)
          `,
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(ellipse 80% 70% at 50% 20%, black 10%, transparent 75%)',
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.12] motion-safe:animate-[drift_40s_linear_infinite]"
        style={{
          background:
            'conic-gradient(from 180deg at 50% 50%, transparent, rgba(251, 191, 36, 0.25), transparent 40%)',
        }}
      />
    </div>
  );
}

const LOGO_SRC = '/argus-logo.png';

/** 3D tilt toward cursor + soft gold bloom. */
export function ParallaxLogo({
  className = '',
  intensity = 11,
  withBloom = true,
}: {
  className?: string;
  intensity?: number;
  withBloom?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rx: 0, ry: 0 });

  const onMove = useCallback(
    (e: React.MouseEvent) => {
      if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const el = wrap.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      setTilt({ ry: px * intensity, rx: py * -intensity * 0.85 });
    },
    [intensity],
  );

  const onLeave = useCallback(() => setTilt({ rx: 0, ry: 0 }), []);

  return (
    <div
      ref={wrap}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={`relative mx-auto select-none ${className}`}
    >
      {withBloom && (
        <div
          className="absolute left-1/2 top-1/2 -z-10 h-[120%] w-[120%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400/25 blur-[48px] motion-safe:animate-[pulse-glow_4.5s_ease-in-out_infinite]"
          aria-hidden
        />
      )}
      <div
        className="relative transition-[transform] duration-150 ease-out will-change-transform motion-reduce:transform-none"
        style={{
          transform: `perspective(1100px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
        }}
      >
        <img
          src={LOGO_SRC}
          alt="Argus"
          draggable={false}
          className="relative z-[1] h-full w-full object-contain drop-shadow-[0_12px_48px_rgba(0,0,0,0.65)] ring-1 ring-amber-400/20 rounded-full"
        />
      </div>
    </div>
  );
}

export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-xl bg-black/50 ring-1 ring-amber-400/25 shadow-[0_0_24px_rgba(251,191,36,0.12)] transition duration-300 ease-out hover:scale-105 hover:ring-amber-400/45 hover:shadow-[0_0_32px_rgba(251,191,36,0.22)] ${className}`}
    >
      <img src={LOGO_SRC} alt="" className="h-full w-full object-contain p-0.5" />
    </div>
  );
}
