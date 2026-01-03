
import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Search, Check } from "lucide-react";

export interface DropdownOption<T extends string | number> {
    value: T;
    label: string;
    description?: string;
    icon?: React.ReactNode;
}

interface DropdownProps<T extends string | number> {
    value: T | null;
    onChange: (value: T) => void;
    options: DropdownOption<T>[];
    placeholder?: string;
    label?: string; // Optional label inside the trigger
    icon?: React.ReactNode; // Optional icon for the trigger
    searchable?: boolean;
    searchPlaceholder?: string;
    className?: string; // For the container
    menuClassName?: string;
    onOpen?: () => void;
}

export function Dropdown<T extends string | number>({
    value,
    onChange,
    options,
    placeholder = "Select...",
    label,
    icon,
    searchable = false,
    searchPlaceholder = "Search...",
    className = "",
    menuClassName = "",
    onOpen,
}: DropdownProps<T>) {
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);

    const selectedOption = options.find((opt) => opt.value === value);

    useEffect(() => {
        if (isOpen) {
            onOpen?.();
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
                setSearchQuery("");
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setIsOpen(false);
                setSearchQuery("");
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEscape);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [isOpen]);

    const filteredOptions = searchable
        ? options.filter((opt) =>
            opt.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
            opt.description?.toLowerCase().includes(searchQuery.toLowerCase())
        )
        : options;

    return (
        <div className={`relative ${className}`} ref={containerRef}>
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between rounded-lg bg-surface-surface border border-border-primary py-2 px-3 text-[11px] text-left hover:border-border-secondary focus:border-border-hover focus:outline-none transition-colors"
            >
                <div className="flex items-center gap-2 min-w-0">
                    {icon && <span className="text-content-muted shrink-0">{icon}</span>}
                    {label && <span className="text-content-muted shrink-0">{label}</span>}
                    <span className={`truncate ${selectedOption ? "text-content-primary" : "text-content-muted"}`}>
                        {selectedOption ? selectedOption.label : placeholder}
                    </span>
                </div>
                <ChevronDown
                    size={14}
                    className={`text-content-muted shrink-0 ml-2 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                />
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.15 }}
                        className={`absolute left-0 right-0 top-full mt-1 z-[9999] rounded-lg border border-border-secondary bg-surface-surface shadow-xl shadow-black/40 overflow-hidden flex flex-col max-h-[280px] ${menuClassName}`}
                    >
                        {searchable && (
                            <div className="p-2 border-b border-border-secondary shrink-0">
                                <div className="relative">
                                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-content-disabled" />
                                    <input
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        placeholder={searchPlaceholder}
                                        autoFocus
                                        className="w-full rounded-md bg-surface-elevated border border-border-secondary py-1.5 pl-7 pr-2.5 text-[11px] text-content-primary placeholder-content-disabled focus:border-content-disabled focus:outline-none transition-colors"
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                </div>
                            </div>
                        )}

                        <div className="overflow-y-auto min-h-[40px]">
                            {filteredOptions.length > 0 ? (
                                filteredOptions.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        onClick={() => {
                                            onChange(option.value);
                                            setIsOpen(false);
                                            setSearchQuery("");
                                        }}
                                        className={`w-full text-left px-3 py-2 transition-colors flex items-center justify-between group ${value === option.value
                                            ? "bg-cloud/10 text-cloud"
                                            : "text-content-secondary hover:bg-surface-elevated hover:text-content-primary"
                                            }`}
                                    >
                                        <div className="flex flex-col gap-0.5 min-w-0">
                                            <span className="text-[12px] font-medium truncate flex items-center gap-2">
                                                {option.icon && <span>{option.icon}</span>}
                                                {option.label}
                                            </span>
                                            {option.description && (
                                                <span className={`text-[10px] truncate ${value === option.value ? "text-cloud/70" : "text-content-disabled group-hover:text-content-muted"
                                                    }`}>
                                                    {option.description}
                                                </span>
                                            )}
                                        </div>
                                        {value === option.value && <Check size={12} className="shrink-0 ml-2" />}
                                    </button>
                                ))
                            ) : (
                                <div className="px-3 py-4 text-[11px] text-content-muted text-center">
                                    No options found
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
