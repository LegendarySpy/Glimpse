import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import { CaretRight, Cloud } from "@phosphor-icons/react";
import ModelCardShell, { waveDots } from "./ModelCardShell";

type CloudModelCardProps = {
  providerLabel: string;
  modelLabel: string | null;
  width?: number;
  onClick?: () => void;
};

const CloudModelCard = ({
  providerLabel,
  modelLabel,
  width,
  onClick,
}: CloudModelCardProps) => {
  const { t } = useLingui();
  const dots = useMemo(
    () => waveDots(`${providerLabel}:${modelLabel ?? ""}`),
    [providerLabel, modelLabel],
  );

  return (
    <ModelCardShell
      accent="var(--model-wave-cloud)"
      glowStrong="var(--model-wave-glow-strong-cloud)"
      glowSoft="var(--model-wave-glow-soft-cloud)"
      dots={dots}
      width={width}
      onClick={onClick}
      ariaLabel={t({
        id: "models.cloud_card.aria",
        message: `${providerLabel} cloud model, manage in Providers`,
      })}
    >
      <div className="flex items-center justify-between gap-3 px-5 pb-4 pt-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Cloud
              size={16}
              weight="fill"
              className="shrink-0 ui-color-cloud"
              aria-hidden="true"
            />
            <h3
              className="ui-color-primary min-w-0 truncate"
              style={{
                fontSize: "1.1875rem",
                fontWeight: 650,
                letterSpacing: "-0.015em",
              }}
            >
              {providerLabel}
            </h3>
          </div>

          <p
            className="ui-color-muted mt-2 min-h-7 min-w-0 truncate font-mono tabular-nums"
            style={{ fontSize: "11.5px" }}
            title={modelLabel ?? undefined}
          >
            {modelLabel ??
              t({
                id: "models.cloud_card.transcribing",
                message: "Cloud transcription",
              })}
          </p>
        </div>

        {onClick && (
          <CaretRight
            size={16}
            weight="bold"
            className="shrink-0 text-content-disabled transition group-hover:translate-x-0.5 group-hover:text-[var(--color-cloud)]"
            aria-hidden="true"
          />
        )}
      </div>
    </ModelCardShell>
  );
};

export default CloudModelCard;
