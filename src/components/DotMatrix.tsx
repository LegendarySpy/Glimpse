import React, { useMemo } from "react";
import { motion } from "framer-motion";

interface DotMatrixProps {
    rows?: number;
    cols?: number;
    activeDots?: number[];
    className?: string;
    dotSize?: number;
    gap?: number;
    color?: string;
    animated?: boolean;
}

const DotMatrix: React.FC<DotMatrixProps> = ({
    rows = 5,
    cols = 20,
    activeDots = [],
    className = "",
    dotSize = 2,
    gap = 4,
    color = "currentColor",
    animated = false,
}) => {
    const dots = useMemo(() => {
        const total = rows * cols;
        return Array.from({ length: total }).map((_, i) => {
            const isActive = activeDots.includes(i);
            const DotComponent = animated ? motion.div : "div";

            return (
                <DotComponent
                    key={i}
                    style={{
                        width: dotSize,
                        height: dotSize,
                        backgroundColor: color,
                        opacity: isActive ? 1 : 0.15,
                        borderRadius: "50%",
                    }}
                    {...(animated && isActive ? {
                        initial: { scale: 0.8, opacity: 0 },
                        animate: { scale: 1, opacity: 1 },
                        transition: { delay: i * 0.002, duration: 0.2 }
                    } : {})}
                />
            );
        });
    }, [rows, cols, activeDots, dotSize, color, animated]);

    return (
        <div
            className={`grid ${className}`}
            style={{
                gridTemplateColumns: `repeat(${cols}, ${dotSize}px)`,
                gap: gap,
                width: "fit-content",
            }}
        >
            {dots}
        </div>
    );
};

export default React.memo(DotMatrix);
