import { useLingui } from "@lingui/react/macro";
import { motion, type Variants } from "framer-motion";
import LanguageModelPanel from "../LanguageModelPanel";
import SpeechModelPanel from "../SpeechModelPanel";
import SectionLabel from "../../../../shared/ui/SectionLabel";
import type { LlmProvider, RemoteSpeechProvider } from "../../../../types";

type ProvidersTabProps = {
  variants: Variants;
  llmEnabled: boolean;
  setLlmEnabled: (value: boolean) => void;
  llmProvider: LlmProvider;
  setLlmProvider: (value: LlmProvider) => void;
  llmEndpoint: string;
  setLlmEndpoint: (value: string) => void;
  llmApiKey: string;
  setLlmApiKey: (value: string) => void;
  llmModel: string;
  setLlmModel: (value: string) => void;
  availableModels: string[];
  fetchAvailableModels: () => void;
  remoteSpeechEnabled: boolean;
  setRemoteSpeechEnabled: (value: boolean) => void;
  remoteSpeechProvider: RemoteSpeechProvider;
  setRemoteSpeechProvider: (value: RemoteSpeechProvider) => void;
  remoteSpeechEndpoint: string;
  setRemoteSpeechEndpoint: (value: string) => void;
  remoteSpeechApiKey: string;
  setRemoteSpeechApiKey: (value: string) => void;
  remoteSpeechModel: string;
  setRemoteSpeechModel: (value: string) => void;
  availableSpeechModels: string[];
  fetchAvailableSpeechModels: () => void;
};

const ProvidersTab = ({
  variants,
  llmEnabled,
  setLlmEnabled,
  llmProvider,
  setLlmProvider,
  llmEndpoint,
  setLlmEndpoint,
  llmApiKey,
  setLlmApiKey,
  llmModel,
  setLlmModel,
  availableModels,
  fetchAvailableModels,
  remoteSpeechEnabled,
  setRemoteSpeechEnabled,
  remoteSpeechProvider,
  setRemoteSpeechProvider,
  remoteSpeechEndpoint,
  setRemoteSpeechEndpoint,
  remoteSpeechApiKey,
  setRemoteSpeechApiKey,
  remoteSpeechModel,
  setRemoteSpeechModel,
  availableSpeechModels,
  fetchAvailableSpeechModels,
}: ProvidersTabProps) => {
  const { t } = useLingui();

  return (
    <motion.div
      key="providers"
      variants={variants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="space-y-5"
    >
      <div className="grid grid-cols-2 items-stretch gap-x-4 gap-y-3">
        <div className="grid row-span-5 [grid-template-rows:subgrid]">
          <SectionLabel>
            {t({
              id: "settings.providers.speech_label",
              message: "Speech",
            })}
          </SectionLabel>
          <SpeechModelPanel
            enabled={remoteSpeechEnabled}
            setEnabled={setRemoteSpeechEnabled}
            provider={remoteSpeechProvider}
            setProvider={setRemoteSpeechProvider}
            endpoint={remoteSpeechEndpoint}
            setEndpoint={setRemoteSpeechEndpoint}
            apiKey={remoteSpeechApiKey}
            setApiKey={setRemoteSpeechApiKey}
            model={remoteSpeechModel}
            setModel={setRemoteSpeechModel}
            availableModels={availableSpeechModels}
            fetchAvailableModels={fetchAvailableSpeechModels}
          />
        </div>

        <div className="grid row-span-5 [grid-template-rows:subgrid]">
          <SectionLabel>
            {t({
              id: "settings.providers.language_label",
              message: "Language",
            })}
          </SectionLabel>
          <LanguageModelPanel
            llmEnabled={llmEnabled}
            setLlmEnabled={setLlmEnabled}
            llmProvider={llmProvider}
            setLlmProvider={setLlmProvider}
            llmEndpoint={llmEndpoint}
            setLlmEndpoint={setLlmEndpoint}
            llmApiKey={llmApiKey}
            setLlmApiKey={setLlmApiKey}
            llmModel={llmModel}
            setLlmModel={setLlmModel}
            availableModels={availableModels}
            fetchAvailableModels={fetchAvailableModels}
          />
        </div>
      </div>
    </motion.div>
  );
};

export default ProvidersTab;
