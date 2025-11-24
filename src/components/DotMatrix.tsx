import React, { useMemo } from "react";

interface DotMatrixProps {
    rows?: number;
    cols?: number;
    activeDots?: number[]; // Indices of dots to be "active" (brighter)
    className?: string;
    dotSize?: number;
    gap?: number;
    color?: string;
}

const DotMatrix: React.FC<DotMatrixProps> = ({
    rows = 5,
    cols = 20,
    activeDots = [],
    className = "",
    dotSize = 2,
    gap = 4,
    color = "currentColor",
}) => {
    const dots = useMemo(() => {
        const total = rows * cols;
        return Array.from({ length: total }).map((_, i) => {
            const isActive = activeDots.includes(i);
            return (
                <div
                    key={i}
                    style={{
                        width: dotSize,
                        height: dotSize,
                        backgroundColor: color,
                        opacity: isActive ? 1 : 0.2,
                        borderRadius: "50%",
                    }}
                />
            );
        });
    }, [rows, cols, activeDots, dotSize, color]);

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

export default DotMatrix;
