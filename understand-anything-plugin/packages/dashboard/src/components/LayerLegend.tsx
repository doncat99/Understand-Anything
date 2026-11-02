import { useDashboardStore } from "../store";
import { useI18n } from "../contexts/I18nContext";

// Shared layer color palette — used by LayerLegend, LayerClusterNode, PortalNode, and GraphView
import { getLayerColor } from "../utils/layer-colors";
export { getLayerColor, LAYER_PALETTE } from "../utils/layer-colors";

export default function LayerLegend() {
  const graph = useDashboardStore((s) => s.graph);
  const navigationLevel = useDashboardStore((s) => s.navigationLevel);
  const activeLayerId = useDashboardStore((s) => s.activeLayerId);
  const { t } = useI18n();

  const layers = graph?.layers ?? [];
  const hasLayers = layers.length > 0;

  if (!hasLayers) return null;

  const activeLayer = layers.find((l) => l.id === activeLayerId);

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium text-text-secondary whitespace-nowrap">
        {navigationLevel === "overview"
          ? `${layers.length} ${t.layer.label}`
          : activeLayer?.name ?? t.layer.defaultName}
      </span>

      <div className="flex items-center gap-3">
        {layers.map((layer, i) => {
          const color = getLayerColor(i);
          const isActive = navigationLevel === "layer-detail" && layer.id === activeLayerId;
          return (
            <div key={layer.id} className="flex items-center gap-1 whitespace-nowrap">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{
                  backgroundColor: color.label,
                  opacity: navigationLevel === "layer-detail" && !isActive ? 0.3 : 1,
                }}
              />
              <span
                className={`text-[11px] ${
                  isActive ? "text-text-primary font-medium" : "text-text-secondary"
                }`}
                style={{
                  opacity: navigationLevel === "layer-detail" && !isActive ? 0.4 : 1,
                }}
              >
                {layer.name}
                <span className="text-text-muted ml-0.5">
                  ({layer.nodeIds.length})
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
