/**
 * Generates new identifier values.
 *
 * Personal OS v0.1 implementations must generate RFC 9562 UUIDv7 strings.
 *
 * The returned value is intentionally kept as a plain string here.
 * The Domain validates and brands it through EntityId.parse(),
 * EvidenceId.parse(), AssertionId.parse(), etc.
 */
export interface IdGeneratorPort {
  generate(): string;
}
