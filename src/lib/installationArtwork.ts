/**
 * Installation must display EXACTLY the currently approved artwork for the
 * same board that Production uses. An upload batch may contain multiple
 * complementary files; a shared file can be current for one board and stale
 * for another. No implicit mapping by file order or by shop alone.
 */
import { latestReviewArtworkGroupByItem, type DesignReviewFile, type DesignReviewLink } from './designReview';

export function approvedInstallationArtworkByItem(
  versions: readonly DesignReviewFile[],
  links: readonly DesignReviewLink[],
): Map<string, DesignReviewFile[]> {
  return latestReviewArtworkGroupByItem(
    versions.filter(file => file.status === 'approved'),
    links,
  );
}

export function isArtworkImage(file: { file_name?: string | null; file_url?: string | null }): boolean {
  const extension = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
  return extension.test((file.file_name || '').trim()) || extension.test((file.file_url || '').split('?')[0]);
}
