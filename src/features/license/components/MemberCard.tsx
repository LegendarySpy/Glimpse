import { useLingui } from "@lingui/react/macro";
import { motion } from "framer-motion";
import { ArrowUpRight, CircleNotch as Loader2 } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
  editionFromLicenseState,
} from "../../../shared/lib/licenseEdition";
import { tierInfo, type PurchaseTier } from "../../license/purchaseConfig";
import { TypewriterText } from "../../../shared/ui/TypewriterText";
import type { LicenseState } from "../api";
import { useDictationStats } from "../queries";
import {
  CARD_TITLE_FONT,
  CardDetailsGrid,
  CardDottedRule,
  CardHeadlineBlock,
  CardHeaderRow,
  CARD_DETAILS_HEIGHT_SLIM,
  CARD_HEADLINE_HEIGHT_EXPANDED,
  formatCardDate,
  getCardShellStyle,
  getMemberCardHeight,
  MemberCardFrame,
  MemberCardPaletteProvider,
  MemberCardPaperOverlays,
  MemberCardStripe,
  STAMP_LAYER_CLASS,
  TierStamp,
  EDITION_STAMP_COLORS,
  TIER_COLORS,
  useMemberCardPalette,
} from "./memberCardShared";
import {
  REVEAL_NAME_SPEED_MS,
  useCardActivationSequence,
} from "./useCardActivationSequence";

export const PLACEHOLDER = "-";

type MemberCardProps = {
  active: boolean;
  activating?: boolean;
  activationAttempt?: number;
  licenseLoading?: boolean;
  licenseState: LicenseState | null;
  openingTarget?: PurchaseTier | null;
  checkoutDisabled?: boolean;
  onOpenCheckout?: (tier: PurchaseTier) => void;
  onRevealComplete?: () => void;
};

const revealEase = [0.22, 1, 0.36, 1] as const;
const stampSlamEase = [0.34, 1.45, 0.64, 1] as const;

const MemberCard = (props: MemberCardProps) => (
  <MemberCardPaletteProvider>
    <MemberCardInner {...props} />
  </MemberCardPaletteProvider>
);

const MemberCardInner = ({
  active,
  activating = false,
  activationAttempt = 0,
  licenseLoading = false,
  licenseState,
  openingTarget = null,
  checkoutDisabled = false,
  onOpenCheckout,
  onRevealComplete,
}: MemberCardProps) => {
  const { t } = useLingui();
  const palette = useMemberCardPalette();
  const [previewTier, setPreviewTier] = useState<PurchaseTier | null>(null);
  const stripeSeedRef = useRef(
    licenseState?.displayKey && active
      ? licenseState.displayKey
      : "draft-glimpse",
  );

  const personal = tierInfo("personal");
  const commercial = tierInfo("commercial");
  const previewInfo = !active && previewTier ? tierInfo(previewTier) : null;

  const displayKey = licenseState?.displayKey ?? null;
  const email = licenseState?.customerEmail ?? null;
  const customerName = licenseState?.customerName ?? null;
  const memberSinceISO =
    licenseState?.purchasedAt ?? licenseState?.activatedAt ?? null;
  const activeDevices = licenseState?.activationsCount ?? null;
  const deviceLimit = licenseState?.activationsLimit ?? 5;

  const edition = editionFromLicenseState(licenseState, active);
  const editionLabel =
    edition === "commercial"
      ? t({ id: "member_card.tier_commercial", message: "Commercial" })
      : edition === "founder"
        ? t({ id: "member_card.tier_founder", message: "Founder" })
        : edition === "contributor"
          ? t({ id: "member_card.tier_contributor", message: "Contributor" })
          : t({ id: "member_card.tier_personal", message: "Personal" });
  const editionBlurb =
    edition === "commercial"
      ? t({
          id: "member_card.edition_blurb_commercial",
          message: "For work. One person per seat, billed yearly.",
        })
      : edition === "founder"
        ? t({
            id: "member_card.edition_blurb_founder",
            message: "Launch founder. Up to 5 devices.",
          })
        : edition === "contributor"
          ? t({
              id: "member_card.edition_blurb_contributor",
              message: "Thank you for contributing. Up to 5 devices.",
            })
          : t({
              id: "member_card.edition_blurb_personal",
              message: "For you. Up to 5 devices.",
            });
  const editionColors = EDITION_STAMP_COLORS[edition];
  const name = customerName?.trim() || null;
  const displayTitle = name || email;
  const memberSinceValue = formatCardDate(memberSinceISO) ?? PLACEHOLDER;
  const dictationStatsQuery = useDictationStats();
  const wordsSpoken = dictationStatsQuery.data?.totalWords ?? null;
  const wordsSpokenValue =
    wordsSpoken !== null ? wordsSpoken.toLocaleString() : PLACEHOLDER;
  const licenseReady = Boolean(active && displayKey && (name || email));

  const cardHeight = getMemberCardHeight();
  const expandedHeadline = !active;
  const tierDisabled = checkoutDisabled || openingTarget !== null;

  const {
    stage,
    cinematic,
    typingReveal,
    showTierPicker,
    showStamp,
    showName,
    showEmail,
    showDetails,
    showCoverage,
    isUserActivationReveal,
    stampSlam,
  } = useCardActivationSequence(
    activating,
    active,
    displayTitle,
    licenseReady,
    licenseLoading,
    activationAttempt,
  );

  const revealCompletedRef = useRef(false);
  useEffect(() => {
    if (!active) {
      revealCompletedRef.current = false;
      return;
    }
    if (
      stage === "done" &&
      isUserActivationReveal &&
      !revealCompletedRef.current
    ) {
      revealCompletedRef.current = true;
      onRevealComplete?.();
    }
  }, [active, stage, isUserActivationReveal, onRevealComplete]);

  const licenseResolved = !licenseLoading || licenseState !== null;
  const showDraftChrome =
    licenseResolved && !active && !cinematic && !activating;

  useEffect(() => {
    if (cinematic) {
      setPreviewTier(null);
    }
  }, [cinematic]);

  useEffect(() => {
    if (stage === "draft") {
      stripeSeedRef.current = "draft-glimpse";
    } else if (displayKey) {
      stripeSeedRef.current = displayKey;
    }
  }, [stage, displayKey]);

  const visualSeed = stripeSeedRef.current;
  const stripeDotTransition =
    isUserActivationReveal && cinematic && displayKey
      ? ("sweep" as const)
      : ("none" as const);
  const tierDisabledForPicker = tierDisabled || cinematic || !showDraftChrome;

  const idlePrompt = t({
    id: "member_card.draft_idle",
    message: "Pick a license",
  });

  const coverageBase = editionBlurb;
  const coverageLine =
    activeDevices !== null
      ? t({
          id: "member_card.coverage_with_devices",
          message: `${coverageBase} · ${activeDevices} of ${deviceLimit} devices active`,
        })
      : coverageBase;

  const titleStyle = {
    fontFamily: CARD_TITLE_FONT,
    fontSize: "1.625rem",
    lineHeight: 1.35,
    margin: 0,
    color:
      showName && displayTitle
        ? palette.textPrimary
        : previewInfo
          ? palette.textPrimary
          : palette.textDisabled,
  } as const;

  const subtitleStyle = {
    fontSize: "13px",
    fontWeight: 500,
    lineHeight: 1.35,
    margin: 0,
    color: palette.textDisabled,
  } as const;

  const handleTierClick = (tierChoice: PurchaseTier) => {
    if (tierDisabledForPicker || !onOpenCheckout) return;
    onOpenCheckout(tierChoice);
  };

  const previewStampLabel = previewInfo?.label;
  const previewStampColors = previewTier
    ? TIER_COLORS[previewTier]
    : TIER_COLORS.personal;

  return (
    <article
      className="relative flex flex-col overflow-visible text-left"
      style={getCardShellStyle(palette)}
      aria-label={
        active
          ? t({
              id: "member_card.aria",
              message: "Glimpse member card",
            })
          : t({
              id: "member_card.draft_aria",
              message: "Draft Glimpse member card",
            })
      }
    >
      <MemberCardPaperOverlays seedKey={visualSeed} cardHeight={cardHeight} />
      <MemberCardFrame>
        <CardHeaderRow
          price={previewInfo?.price ?? null}
          priceColor={previewTier ? TIER_COLORS[previewTier].fg : undefined}
          stamp={
            showStamp && displayKey ? (
              <SlamTierStamp
                key={displayKey}
                label={editionLabel}
                color={editionColors.fg}
                bg={editionColors.bg}
                playSlam={isUserActivationReveal && stampSlam}
              />
            ) : previewStampLabel ? (
              <motion.div
                key={previewTier}
                className={STAMP_LAYER_CLASS}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
              >
                <TierStamp
                  label={previewStampLabel}
                  color={previewStampColors.fg}
                  bg={previewStampColors.bg}
                />
              </motion.div>
            ) : (
              <span
                className="absolute inset-x-0 flex justify-end font-mono uppercase tracking-[0.16em]"
                style={{
                  top: "-11px",
                  fontSize: "10px",
                  fontWeight: 700,
                  lineHeight: 1.35,
                  color: palette.textDisabled,
                  textShadow: palette.wordmarkShadow,
                  opacity: cinematic ? 0.25 : 0.55,
                }}
              >
                {cinematic
                  ? t({
                      id: "member_card.draft_stamp_issuing",
                      message: "Issuing",
                    })
                  : t({
                      id: "member_card.draft_stamp_empty",
                      message: "Unissued",
                    })}
              </span>
            )
          }
        />

        <CardHeadlineBlock
          height={expandedHeadline ? CARD_HEADLINE_HEIGHT_EXPANDED : undefined}
          title={
            showName && displayTitle ? (
              typingReveal ? (
                <TypewriterText
                  key={`reveal-name-${displayKey}`}
                  text={displayTitle}
                  as="h2"
                  className="font-bold tracking-[-0.02em] break-words"
                  style={{
                    ...titleStyle,
                    ...(displayTitle === email
                      ? { fontSize: "1.25rem", lineHeight: 1.15 }
                      : {}),
                  }}
                  speedMs={REVEAL_NAME_SPEED_MS}
                />
              ) : (
                <h2
                  className="font-bold tracking-[-0.02em] break-words"
                  style={{
                    ...titleStyle,
                    ...(displayTitle === email
                      ? { fontSize: "1.25rem", lineHeight: 1.15 }
                      : {}),
                  }}
                >
                  {displayTitle}
                </h2>
              )
            ) : cinematic ? (
              <motion.h2
                className="font-bold tracking-[-0.02em] break-words"
                style={{
                  ...titleStyle,
                  color: palette.textDisabled,
                  opacity: 0.35,
                }}
                initial={{ opacity: 0.55 }}
                animate={{ opacity: 0.35 }}
                transition={{ duration: 0.45 }}
              >
                {PLACEHOLDER}
              </motion.h2>
            ) : active ? (
              <h2
                className="font-bold tracking-[-0.02em] break-words"
                style={{ ...titleStyle, color: palette.textDisabled }}
              >
                {PLACEHOLDER}
              </h2>
            ) : previewInfo ? (
              <h2
                className="font-bold tracking-[-0.02em] break-words"
                style={titleStyle}
              >
                {previewInfo.label}
              </h2>
            ) : (
              <h2
                className="font-bold tracking-[-0.02em] break-words"
                style={titleStyle}
              >
                {idlePrompt}
              </h2>
            )
          }
          subtitle={
            showEmail && name && email ? (
              typingReveal ? (
                <TypewriterText
                  key={`reveal-email-${displayKey}`}
                  text={email}
                  as="p"
                  className="break-words"
                  style={subtitleStyle}
                  speedMs={22}
                />
              ) : (
                <p className="break-words" style={subtitleStyle}>
                  {email}
                </p>
              )
            ) : cinematic ? (
              <span aria-hidden="true">&nbsp;</span>
            ) : previewInfo ? (
              <p className="break-words" style={subtitleStyle}>
                {previewInfo.blurb}
              </p>
            ) : (
              <span aria-hidden="true">&nbsp;</span>
            )
          }
        />

        <CardDetailsGrid
          height={expandedHeadline ? CARD_DETAILS_HEIGHT_SLIM : undefined}
        >
          {active ? (
            <>
              <StatDetail
                label={t({
                  id: "member_card.label_member_since",
                  message: "Member since",
                })}
                value={memberSinceValue}
                show={showDetails}
              />
              <StatDetail
                label={t({
                  id: "member_card.label_words_spoken",
                  message: "Words spoken",
                })}
                value={wordsSpokenValue}
                show={showDetails}
                delaySec={0.12}
              />
            </>
          ) : null}

          <div className="relative col-span-2 shrink-0 pt-1">
            <CardDottedRule />
            <div className="relative mt-1.5 min-h-[28px]">
              {showTierPicker && showDraftChrome ? (
                <div className="absolute inset-0 flex items-stretch gap-0">
                  <TierOption
                    label={personal.label}
                    price={personal.price}
                    inlinePrice={personal.pickerPrice}
                    accent={TIER_COLORS.personal}
                    active={previewTier === "personal"}
                    opening={openingTarget === "personal"}
                    disabled={tierDisabledForPicker}
                    onHover={() => setPreviewTier("personal")}
                    onClick={() => handleTierClick("personal")}
                  />
                  <div
                    aria-hidden="true"
                    className="mx-1.5 my-1.5 w-px shrink-0"
                    style={{
                      backgroundImage: `repeating-linear-gradient(to bottom, ${palette.border} 0, ${palette.border} 2px, transparent 2px, transparent 5px)`,
                    }}
                  />
                  <TierOption
                    label={commercial.label}
                    price={commercial.price}
                    inlinePrice={commercial.pickerPrice}
                    accent={TIER_COLORS.commercial}
                    active={previewTier === "commercial"}
                    opening={openingTarget === "commercial"}
                    disabled={tierDisabledForPicker}
                    onHover={() => setPreviewTier("commercial")}
                    onClick={() => handleTierClick("commercial")}
                  />
                </div>
              ) : showCoverage ? (
                isUserActivationReveal &&
                typingReveal &&
                stage === "coverage" ? (
                  <motion.div
                    key="coverage-reveal"
                    className="absolute inset-x-0 top-0 truncate font-mono"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.55, ease: revealEase }}
                  >
                    <TypewriterText
                      text={coverageLine}
                      as="p"
                      style={{
                        fontSize: "10px",
                        fontWeight: 500,
                        color: palette.textDisabled,
                        letterSpacing: "0.02em",
                      }}
                      speedMs={20}
                    />
                  </motion.div>
                ) : (
                  <p
                    className="absolute inset-x-0 top-0 truncate font-mono"
                    style={{
                      fontSize: "10px",
                      fontWeight: 500,
                      color: palette.textDisabled,
                      letterSpacing: "0.02em",
                    }}
                  >
                    {coverageLine}
                  </p>
                )
              ) : cinematic ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 block font-mono"
                  style={{
                    fontSize: "10px",
                    color: palette.textDisabled,
                    opacity: 0.3,
                  }}
                >
                  {PLACEHOLDER}
                </span>
              ) : null}
            </div>
          </div>
        </CardDetailsGrid>

        <MemberCardStripe
          seedKey={visualSeed}
          transitionMode={stripeDotTransition}
        />
      </MemberCardFrame>
    </article>
  );
};

const SlamTierStamp = ({
  label,
  color,
  bg,
  playSlam,
}: {
  label: string;
  color: string;
  bg: string;
  playSlam: boolean;
}) => {
  if (!playSlam) {
    return (
      <div className={STAMP_LAYER_CLASS}>
        <TierStamp label={label} color={color} bg={bg} />
      </div>
    );
  }

  return (
    <motion.div
      className={STAMP_LAYER_CLASS}
      initial={{
        opacity: 0,
        scale: 1.55,
        rotate: -18,
        y: -18,
        filter: "blur(1px)",
      }}
      animate={{
        opacity: [0, 0.86, 1],
        scale: [1.55, 0.96, 1],
        rotate: [-18, 1.5, 0],
        y: [-18, 2, 0],
        filter: ["blur(1px)", "blur(0px)", "blur(0px)"],
      }}
      transition={{
        duration: 0.42,
        times: [0, 0.62, 1],
        ease: stampSlamEase,
      }}
    >
      <TierStamp label={label} color={color} bg={bg} />
    </motion.div>
  );
};

const StatDetail = ({
  label,
  value,
  show,
  delaySec = 0,
}: {
  label: string;
  value: string;
  show: boolean;
  delaySec?: number;
}) => {
  const palette = useMemberCardPalette();

  return (
    <motion.div
      className="min-w-0"
      initial={false}
      animate={{ opacity: show ? 1 : 0, y: show ? 0 : 4 }}
      transition={{
        duration: 0.5,
        ease: revealEase,
        delay: show ? delaySec : 0,
      }}
    >
      <dt
        className="font-mono uppercase tracking-[0.16em]"
        style={{
          fontSize: "9.5px",
          fontWeight: 600,
          color: palette.textDisabled,
        }}
      >
        {label}
      </dt>
      <dd
        className="mt-1 break-words font-mono"
        style={{
          fontSize: "13px",
          fontWeight: 500,
          color: palette.textPrimary,
        }}
      >
        {value}
      </dd>
    </motion.div>
  );
};

const TierOption = ({
  label,
  price,
  inlinePrice,
  accent,
  active,
  opening,
  disabled,
  onHover,
  onClick,
}: {
  label: string;
  price: string;
  inlinePrice?: string;
  accent: { fg: string; bg: string };
  active?: boolean;
  opening?: boolean;
  disabled?: boolean;
  onHover: () => void;
  onClick: () => void;
}) => {
  const { t } = useLingui();
  const palette = useMemberCardPalette();
  const highlighted = active || opening;
  const pickerLabel = inlinePrice ? `${label} · ${inlinePrice}` : label;

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      disabled={disabled && !opening}
      aria-label={t({
        id: "member_card.tier_purchase_aria",
        message: `Purchase ${label} for ${price}`,
      })}
      className="group flex min-w-0 flex-1 items-center justify-between gap-1.5 border-0 bg-transparent py-1.5 text-left disabled:opacity-50"
      style={{ color: highlighted ? accent.fg : palette.textPrimary }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="shrink-0"
          style={{
            width: "8px",
            height: "8px",
            border: `1px solid ${highlighted ? accent.fg : palette.textDisabled}`,
            backgroundColor: highlighted ? accent.fg : "transparent",
            opacity: highlighted ? 0.88 : 0.45,
          }}
        />
        <span
          className="truncate font-mono uppercase tracking-[0.05em]"
          style={{
            fontSize: "10px",
            fontWeight: 600,
            textDecoration: highlighted ? "underline" : "none",
            textUnderlineOffset: "3px",
            textDecorationColor: highlighted
              ? `color-mix(in srgb, ${accent.fg} 70%, transparent)`
              : undefined,
          }}
        >
          {pickerLabel}
        </span>
      </span>
      {opening ? (
        <Loader2
          size={11}
          className="shrink-0 animate-spin"
          style={{ color: accent.fg }}
        />
      ) : (
        <ArrowUpRight
          size={11}
          className="shrink-0 transition-opacity group-hover:opacity-100"
          style={{ color: accent.fg, opacity: highlighted ? 0.85 : 0.45 }}
          aria-hidden="true"
        />
      )}
    </button>
  );
};

export default MemberCard;
