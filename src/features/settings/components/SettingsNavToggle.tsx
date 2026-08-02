import { motion, AnimatePresence } from "framer-motion";
import { GearSix, type Icon as PhosphorIcon } from "@phosphor-icons/react";

const EXPO_OUT = [0.16, 1, 0.3, 1] as const;

interface SettingsNavToggleProps {
  open: boolean;
  /** Icon of the view this returns to, so the gear turns into the way back. */
  returnIcon: PhosphorIcon;
  collapsed: boolean;
  openLabel: string;
  closeLabel: string;
  onClick: () => void;
}

const SettingsNavToggle = ({
  open,
  returnIcon: ReturnIcon,
  collapsed,
  openLabel,
  closeLabel,
  onClick,
}: SettingsNavToggleProps) => (
  <button
    onClick={onClick}
    data-active={open ? "true" : "false"}
    aria-label={open ? closeLabel : openLabel}
    className={`ui-nav-item group h-9 pl-[var(--sidebar-icon-pl,17px)] pr-3 mb-[2px] ${
      collapsed ? "gap-0" : "gap-3"
    }`}
  >
    <div className="relative flex h-5 w-[20px] shrink-0 items-center justify-center">
      <motion.span
        className="absolute inset-0 flex items-center justify-center"
        animate={{
          rotate: open ? -100 : 0,
          opacity: open ? 0 : 1,
          scale: open ? 0.55 : 1,
        }}
        transition={{ duration: 0.26, ease: EXPO_OUT }}
      >
        <GearSix size={20} />
      </motion.span>
      <motion.span
        className="absolute inset-0 flex items-center justify-center"
        animate={{
          rotate: open ? 0 : 70,
          opacity: open ? 1 : 0,
          scale: open ? 1 : 0.55,
        }}
        transition={{ duration: 0.26, ease: EXPO_OUT }}
      >
        <ReturnIcon size={20} weight="fill" />
      </motion.span>
    </div>
    <span
      style={{ width: collapsed ? 0 : "auto", opacity: collapsed ? 0 : 1 }}
      className="relative overflow-hidden whitespace-nowrap ui-text-nav-item transition-[width,opacity] duration-200 ease-out"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={open ? "close" : "open"}
          className="block"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.14, ease: "easeOut" }}
        >
          {open ? closeLabel : openLabel}
        </motion.span>
      </AnimatePresence>
    </span>
  </button>
);

export default SettingsNavToggle;
