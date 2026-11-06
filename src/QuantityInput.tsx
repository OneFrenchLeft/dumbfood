import { useEffect, useId, useRef } from "react";
import { Minus, Plus } from "lucide-react";
import type { Unit } from "../shared/types";

const MAX_QUANTITY = 1_000_000_000;
const INTEGER = /^[0-9]+$/;
const DECIMAL = /^(?:[0-9]+(?:[.,][0-9]+)?|[.,][0-9]+)$/;

export function parseQuantity(value: string): number {
  const normalized = value.trim().replace(",", ".");
  return normalized ? Number(normalized) : Number.NaN;
}

function validationMessage(value: string, unit: Unit): string {
  if (value === "") return "";
  if (!(unit === "L" ? DECIMAL : INTEGER).test(value)) {
    return unit === "L"
      ? "Entrez une quantité en litres."
      : "Entrez un nombre entier pour cette unité.";
  }
  const quantity = parseQuantity(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return "La quantité doit être supérieure à zéro.";
  }
  if (quantity > MAX_QUANTITY) return "La quantité est trop grande.";
  if (unit !== "L" && !Number.isInteger(quantity)) {
    return "Entrez un nombre entier pour cette unité.";
  }
  return "";
}

// Alter the whole-number portion so litres retain their exact typed fraction.
function increment(value: string, direction: 1 | -1): string {
  if (!value) return "1";
  const separator = value.includes(",") ? "," : ".";
  const [whole, fraction] = value.replace(",", ".").split(".");
  const nextWhole = BigInt(whole || "0") + BigInt(direction);
  return `${nextWhole}${fraction === undefined ? "" : separator + fraction}`;
}

export interface QuantityInputProps {
  id?: string;
  label: string;
  unit: Unit;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
  unitLabel?: string;
  disabled?: boolean;
}

export default function QuantityInput({
  id,
  label,
  unit,
  value,
  onChange,
  required = false,
  placeholder,
  unitLabel,
  disabled = false,
}: QuantityInputProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const input = useRef<HTMLInputElement>(null);
  const message = validationMessage(value, unit);
  const numericValue = parseQuantity(value);
  const canStep = value === "" || !message;
  const canDecrease =
    !disabled && canStep && value !== "" && numericValue - 1 > 0;
  const canIncrease =
    !disabled && canStep && (value === "" || numericValue + 1 <= MAX_QUANTITY);

  useEffect(() => {
    input.current?.setCustomValidity(message);
  }, [message, value, unit]);

  function step(direction: 1 | -1) {
    if (direction === 1 ? canIncrease : canDecrease) {
      onChange(increment(value, direction));
    }
  }

  return (
    <div className={`quantity-control${disabled ? " disabled" : ""}`}>
      <button
        className="quantity-step"
        type="button"
        aria-label={`Diminuer ${label.toLocaleLowerCase("fr-FR")}`}
        aria-controls={inputId}
        disabled={!canDecrease}
        onClick={() => step(-1)}
      >
        <Minus size={17} aria-hidden="true" />
      </button>
      <input
        ref={input}
        id={inputId}
        className="quantity-value"
        type="text"
        role="spinbutton"
        aria-label={label}
        aria-valuenow={Number.isFinite(numericValue) ? numericValue : undefined}
        aria-valuemin={unit === "L" ? 0 : 1}
        aria-valuemax={MAX_QUANTITY}
        aria-invalid={value !== "" && message !== "" ? true : undefined}
        aria-describedby={unitLabel ? `${inputId}-unit` : undefined}
        inputMode={unit === "L" ? "decimal" : "numeric"}
        pattern={
          unit === "L" ? "(?:[0-9]+(?:[.,][0-9]+)?|[.,][0-9]+)" : "[0-9]+"
        }
        autoComplete="off"
        spellCheck={false}
        required={required}
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          if (
            (unit === "L" ? /^[0-9]*(?:[.,][0-9]*)?$/ : /^[0-9]*$/).test(next)
          ) {
            onChange(next);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            step(event.key === "ArrowUp" ? 1 : -1);
          }
        }}
      />
      {unitLabel && (
        <span className="quantity-unit" id={`${inputId}-unit`}>
          {unitLabel}
        </span>
      )}
      <button
        className="quantity-step"
        type="button"
        aria-label={`Augmenter ${label.toLocaleLowerCase("fr-FR")}`}
        aria-controls={inputId}
        disabled={!canIncrease}
        onClick={() => step(1)}
      >
        <Plus size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
