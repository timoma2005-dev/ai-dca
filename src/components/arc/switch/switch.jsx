// Vendored from Arc (uiarc.dev, MIT). Types stripped; CSS vars renamed to --arc-*.
import { forwardRef, useEffect, useRef, useState } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { motionTokens } from "../lib/motion-tokens.js";
import styles from "./switch.module.css";
const size = 18;
const travel = 18;
const stretch = 5;
const glide = { ...motionTokens.spring.smooth };
const Switch = forwardRef(function Switch2({ label, className, checked, defaultChecked, onCheckedChange, onPointerDown, onPointerUp, onPointerLeave, onPointerCancel, onKeyDown, onKeyUp, onBlur, ...props }, ref) {
  const reduceMotion = useReducedMotion();
  const [internal, setInternal] = useState(defaultChecked ?? false);
  const [pressed, setPressed] = useState(false);
  const on = checked ?? internal;
  const scaleX = useMotionValue(1);
  const shown = useRef(on);
  const releasedAt = useRef(-Infinity);
  useEffect(() => {
    if (shown.current === on) return;
    shown.current = on;
    const fromPress = performance.now() - releasedAt.current < 250;
    if (reduceMotion || fromPress) return;
    const controls = animate(scaleX, [1, 1.16, 1], { duration: glide.visualDuration, times: [0, 0.4, 1], ease: ["easeOut", "easeInOut"] });
    return () => controls.stop();
  }, [on, reduceMotion, scaleX]);
  const extra = pressed && !reduceMotion && !props.disabled ? stretch : 0;
  const classes = [styles.switch, className].filter(Boolean).join(" ");
  return <SwitchPrimitive.Root
    {...props}
    ref={ref}
    checked={on}
    onCheckedChange={(next) => {
      if (checked === void 0) setInternal(next);
      onCheckedChange?.(next);
    }}
    onPointerDown={(event) => {
      onPointerDown?.(event);
      if (event.button === 0) setPressed(true);
    }}
    onPointerUp={(event) => {
      onPointerUp?.(event);
      if (pressed && !props.disabled) releasedAt.current = performance.now();
      setPressed(false);
    }}
    onPointerLeave={(event) => {
      onPointerLeave?.(event);
      setPressed(false);
    }}
    onPointerCancel={(event) => {
      onPointerCancel?.(event);
      setPressed(false);
    }}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (event.key === " ") setPressed(true);
    }}
    onKeyUp={(event) => {
      onKeyUp?.(event);
      if (pressed && !props.disabled) releasedAt.current = performance.now();
      setPressed(false);
    }}
    onBlur={(event) => {
      onBlur?.(event);
      setPressed(false);
    }}
    className={classes}
    aria-label={props["aria-label"] ?? label}
  >
      <span className={styles.track}>
        {
    /* The thumb stretches like a held finger and keeps its far edge anchored, then travels on a spring. */
  }
        <motion.span className={styles.thumb} style={{ scaleX }} initial={false} animate={{ x: on ? travel - extra : 0, width: size + extra }} transition={reduceMotion ? { duration: 0 } : { x: glide, width: motionTokens.spring.snappy }} />
      </span>
      {label ? <span className={styles.label}>{label}</span> : null}
    </SwitchPrimitive.Root>;
});
Switch.displayName = "Switch";
var switch_default = Switch;
export {
  Switch,
  switch_default as default
};
