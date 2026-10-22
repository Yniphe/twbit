export const RELATIONSHIP_STYLES = {
  auto: { label: "Как со всеми", instruction: "Обычный стиль чата" },
  friendly: {
    label: "Свой человек",
    instruction: "Тепло, на равных, с дружескими подколами",
  },
  banter: {
    label: "Подкалывать",
    instruction: "Подхватывай взаимный стёб, остро подкалывай по фактам",
  },
  gentle: {
    label: "Помягче",
    instruction: "Без жёстких подколов и личных наездов",
  },
  ignore: {
    label: "Не трогать",
    instruction: "Не адресуй реплик этому зрителю",
  },
} as const;
export type RelationshipStyle = keyof typeof RELATIONSHIP_STYLES;
