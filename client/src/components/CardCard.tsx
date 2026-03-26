import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";

interface CardData {
  id: string;
  name: string;
  manaCost: string | null;
  cmc: number;
  type: string;
  rarity: string;
  text: string | null;
  imageUrl: string | null;
}

interface CardCardProps {
  card: CardData;
  quantity?: number;
  onRemove?: () => void;
}

export default function CardCard({ card, quantity, onRemove }: CardCardProps) {
  return (
    <Card className="bg-slate-900/50 border-purple-500/30 hover:border-purple-500/60 transition-colors overflow-hidden">
      <div className="h-32 bg-gradient-to-br from-purple-600/20 to-pink-600/20 flex items-center justify-center">
        {card.imageUrl ? (
          <img src={card.imageUrl} alt={card.name} className="w-full h-full object-cover" />
        ) : (
          <div className="text-center">
            <p className="text-gray-400 text-xs">No image</p>
          </div>
        )}
      </div>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-start">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-white text-sm truncate">{card.name}</CardTitle>
            <CardDescription className="text-gray-400 text-xs truncate">{card.type}</CardDescription>
          </div>
          {quantity && (
            <Badge variant="secondary" className="ml-2 text-xs">
              {quantity}
            </Badge>
          )}
          {onRemove && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onRemove}
              className="ml-2 h-6 w-6 p-0 text-red-400 hover:text-red-300"
            >
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex justify-between items-center text-xs">
          <div>
            <span className="text-gray-500">CMC:</span>
            <span className="text-white ml-1">{card.cmc}</span>
          </div>
          <Badge variant="outline" className="text-xs capitalize">
            {card.rarity}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}