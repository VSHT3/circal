import { useState } from "react";
import { Download } from "lucide-react";
import { ActionPill } from "@/components/react/ui/primitives";
import { notify } from "@/lib/notify";
import { saveFace } from "@/components/react/ui/faceExport";

export default function SaveFace() {
  const [saving, setSaving] = useState(false);
  async function save(format: "svg" | "png") {
    setSaving(true);
    try {
      if (await saveFace(format))
        notify(`Saved face as ${format.toUpperCase()}. It includes visible event details`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save the face", "error");
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ActionPill
          label="Save face as SVG"
          icon={
            <>
              <Download size={13} strokeWidth={1.75} /> SVG
            </>
          }
          disabled={saving}
          onClick={() => void save("svg")}
        />
        <ActionPill
          label="Save face as PNG"
          icon={
            <>
              <Download size={13} strokeWidth={1.75} /> PNG
            </>
          }
          disabled={saving}
          onClick={() => void save("png")}
        />
      </div>
      <span className="caption">
        Save the day or year face. Visible event details travel with the image; nothing is uploaded.
      </span>
    </>
  );
}
