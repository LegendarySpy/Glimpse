import { motion, AnimatePresence } from "framer-motion";
import { X, HelpCircle } from "lucide-react";
import DotMatrix from "./DotMatrix";

interface FAQModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const faqItems = [
    {
        question: "How is Glimpse free?",
        answer: "Glimpse uses on-device OSS AI models for transcription, so there are no ongoing costs for the core experience.",
    },
    {
        question: "Is my data private?",
        answer: "Yes. In local mode, all your audio and transcriptions stay on your device. We never collect or transmit your recordings. Cloud sync is optional.",
    },
    {
        question: "What's Glimpse Cloud?",
        answer: "An optional paid upgrade with cross-device sync, faster cloud processing, and better AI models.",
    },
    {
        question: "How is my data used?",
        answer: "Your data, is your data. Not ours to share. We will never sell or share your data with third parties. ",
    },
    {
        question: "What if I want to delete my data?",
        answer: "Delete recordings locally to remove them. Synced data is flagged for removal immediately when you delete it.",
    },
];

const FAQModal = ({ isOpen, onClose }: FAQModalProps) => {
    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 20 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                        className="relative bg-surface-secondary border border-border-primary rounded-2xl overflow-hidden max-w-md w-full mx-4 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="relative flex items-center justify-between p-5 border-b border-border-primary">
                            <div className="flex items-center gap-3">
                                <div className="flex items-center justify-center w-8 h-8">
                                    <HelpCircle size={16} className="text-amber-400" />
                                </div>
                                <div>
                                    <h2 className="text-[15px] font-semibold text-white">Frequently Asked Questions</h2>
                                    <p className="text-[11px] text-content-muted">Common questions about Glimpse</p>
                                </div>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 rounded-lg hover:bg-surface-elevated text-content-disabled hover:text-white transition-colors"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        <div className="relative p-5 space-y-3 max-h-[60vh] overflow-y-auto">
                            {faqItems.map((item, index) => (
                                <div
                                    key={index}
                                    className="p-4 rounded-xl bg-surface-tertiary border border-border-primary hover:border-border-secondary transition-colors"
                                >
                                    <h3 className="text-[13px] font-medium text-content-primary mb-1.5">
                                        {item.question}
                                    </h3>
                                    <p className="text-[12px] text-content-muted leading-relaxed">
                                        {item.answer}
                                    </p>
                                </div>
                            ))}
                        </div>

                        <div className="relative flex items-center justify-between p-4 border-t border-border-primary bg-surface-primary">
                            <div className="flex items-center gap-2">
                                <DotMatrix rows={2} cols={2} activeDots={[0, 3]} dotSize={3} gap={2} color="var(--color-cloud)" />
                                <span className="text-[10px] text-content-disabled">Glimpse</span>
                            </div>
                            <button
                                onClick={onClose}
                                className="px-4 py-2 rounded-lg bg-surface-elevated border border-border-secondary text-[12px] font-medium text-content-secondary hover:text-white hover:border-border-hover transition-colors"
                            >
                                Got it
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default FAQModal;
