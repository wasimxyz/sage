import { useEntry } from "@/components/journal-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DeleteEntryDialog() {
  const {
    actions: { confirmDelete, setDeleteOpen },
    state: { deleteOpen, deleteTitle },
  } = useEntry();
  return (
    <Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this entry?</DialogTitle>
          <DialogDescription>
            This removes "{deleteTitle}" from your journal on this machine.
            Memories Dream took from this entry go too. You cannot undo it.
          </DialogDescription>
        </DialogHeader>
        <DialogActions>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button onClick={confirmDelete} variant="destructive">
            Delete
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
